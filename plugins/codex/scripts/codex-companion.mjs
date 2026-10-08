#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildRegisteredThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import {
  acquireThread,
  findLatestThread,
  forgetThread,
  listThreads,
  releaseThread,
  reserveThread,
  resolveThread,
  validateThreadName
} from "./lib/threads.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  appendThreadBlock,
  formatRelativeTime,
  renderThreadsReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
// Set by the spike recorded in docs/superpowers/spikes/2026-10-08-native-review-follow-up.md.
const NATIVE_REVIEW_REGISTERS = "sourceThreadId";
const NATIVE_REVIEW_FOLLOW_UP = true;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--name <thread>] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--name <thread>] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--name <thread>|--thread <ref>|--resume-last|--resume|--fresh] [--ephemeral] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs ask <thread> [--background|--wait] [--write] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs threads [--json]",
      "  node scripts/codex-companion.mjs forget <thread> [--json]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/cx:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/cx:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/cx:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/cx:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/cx:review` target is not supported by the built-in reviewer. Retry with `/cx:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

function threadSummary(entry) {
  return entry ? { name: entry.name, threadId: entry.threadId ?? null } : null;
}

// A run can fail after Codex has created the thread. The first thread id a run
// reports is its own, so remembering it lets the registry keep that thread.
function trackStartedThread(onProgress) {
  const tracker = {
    threadId: null,
    onProgress(event) {
      if (!tracker.threadId && event && typeof event === "object" && event.threadId) {
        tracker.threadId = event.threadId;
      }
      onProgress?.(event);
    }
  };
  return tracker;
}

function releaseFailedThread(workspaceRoot, jobId, threadId) {
  releaseThread(workspaceRoot, jobId, { threadId: threadId ?? undefined, dropIfUnstarted: true });
}

function findThreadHeldByJob(workspaceRoot, jobId) {
  if (!jobId) {
    return null;
  }
  return listThreads(workspaceRoot).find((entry) => entry.activeJobId === jobId) ?? null;
}

// Background launches reserve or lock the thread before the worker starts, so
// a second command sees it as busy immediately. The worker then finds the
// thread already held by its own job id.
function holdThreadForBackgroundJob(workspaceRoot, request) {
  if (request.threadRef) {
    const entry = resolveThread(workspaceRoot, request.threadRef);
    return acquireThread(workspaceRoot, entry.name, request.jobId);
  }
  if (request.resumeLast || request.ephemeral) {
    return null;
  }
  return reserveThread(workspaceRoot, {
    name: request.threadName,
    kind: "task",
    sandbox: request.write ? "workspace-write" : "read-only",
    model: request.model ?? null,
    sessionId: getCurrentClaudeSessionId(),
    jobId: request.jobId,
    prompt: request.prompt
  });
}

async function resolveTaskThread(workspaceRoot, request) {
  const held = findThreadHeldByJob(workspaceRoot, request.jobId);
  if (held) {
    return { entry: held, fallbackThreadId: null };
  }
  if (request.threadRef) {
    const entry = resolveThread(workspaceRoot, request.threadRef);
    return { entry: acquireThread(workspaceRoot, entry.name, request.jobId), fallbackThreadId: null };
  }
  if (request.resumeLast) {
    const latest = findLatestThread(workspaceRoot, { kind: "task", includeBusy: true });
    if (latest) {
      return { entry: acquireThread(workspaceRoot, latest.name, request.jobId), fallbackThreadId: null };
    }
    const fallback = await findLatestTaskThread(workspaceRoot);
    if (!fallback) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    return { entry: null, fallbackThreadId: fallback.id };
  }
  return { entry: null, fallbackThreadId: null };
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  const reviewTarget = reviewName === "Review" ? validateNativeReviewRequest(target, focusText) : null;
  const reservedPrompt = `${reviewName} ${target.label}${focusText ? `: ${focusText}` : ""}`;
  const entry = request.ephemeral
    ? null
    : reserveThread(workspaceRoot, {
        name: request.threadName,
        kind: reviewName === "Review" ? "review" : "adversarial-review",
        sandbox: "read-only",
        model: request.model ?? null,
        sessionId: getCurrentClaudeSessionId(),
        jobId: request.jobId,
        prompt: reservedPrompt
      });
  if (entry && request.jobId) {
    upsertJob(workspaceRoot, { id: request.jobId, threadName: entry.name });
  }
  const codexThreadName = entry ? buildRegisteredThreadName(entry.name) : null;
  const tracker = trackStartedThread(request.onProgress);
  const runRegistered = async (runner) => {
    try {
      return await runner();
    } catch (error) {
      if (entry) {
        releaseFailedThread(workspaceRoot, request.jobId, tracker.threadId);
      }
      throw error;
    }
  };
  const finishThread = (result, registeredThreadId) => {
    if (!entry) {
      return null;
    }
    const [released] = releaseThread(workspaceRoot, request.jobId, {
      threadId: registeredThreadId,
      lastPrompt: reservedPrompt,
      lastJobId: request.jobId,
      turnCompleted: result.status === 0
    });
    return threadSummary(released ?? entry);
  };

  if (reviewName === "Review") {
    const result = await runRegistered(() =>
      runAppServerReview(request.cwd, {
        target: reviewTarget,
        model: request.model,
        onProgress: tracker.onProgress,
        persistThread: Boolean(entry),
        threadName: codexThreadName
      })
    );
    const registeredThreadId = result[NATIVE_REVIEW_REGISTERS] ?? result.threadId;
    const thread = finishThread(result, registeredThreadId);
    const payload = {
      review: reviewName,
      target,
      thread,
      threadId: registeredThreadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = appendThreadBlock(
      renderNativeReviewResult(
        {
          status: result.status,
          stdout: result.reviewText,
          stderr: result.stderr
        },
        { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
      ),
      thread
    );

    return {
      exitStatus: result.status,
      threadId: registeredThreadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runRegistered(() =>
    runAppServerTurn(context.repoRoot, {
      prompt,
      model: request.model,
      sandbox: "read-only",
      outputSchema: readOutputSchema(REVIEW_SCHEMA),
      onProgress: tracker.onProgress,
      persistThread: Boolean(entry),
      threadName: codexThreadName
    })
  );
  const thread = finishThread(result, result.threadId);
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    thread,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: appendThreadBlock(
      renderReviewResult(parsed, {
        reviewLabel: reviewName,
        targetLabel: context.target.label,
        reasoningSummary: result.reasoningSummary
      }),
      thread
    ),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: Boolean(request.resumeLast || request.threadRef)
  });
  const prompt = request.prompt?.trim() || "";

  let { entry, fallbackThreadId } = await resolveTaskThread(workspaceRoot, request);
  let sandbox = request.write ? "workspace-write" : "read-only";
  let model = request.model ?? null;
  let resumeThreadId = fallbackThreadId;

  if (entry?.threadId) {
    resumeThreadId = entry.threadId;
    if (!request.write) {
      sandbox = entry.sandbox;
    }
    if (!model) {
      model = entry.model;
    }
  } else if (!entry && !resumeThreadId && !request.ephemeral) {
    entry = reserveThread(workspaceRoot, {
      name: request.threadName,
      kind: "task",
      sandbox,
      model,
      sessionId: getCurrentClaudeSessionId(),
      jobId: request.jobId,
      prompt
    });
  }

  if (entry && request.jobId) {
    upsertJob(workspaceRoot, { id: request.jobId, threadName: entry.name });
  }

  const tracker = trackStartedThread(request.onProgress);
  let result;
  try {
    if (!prompt && !resumeThreadId) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
    }
    result = await runAppServerTurn(workspaceRoot, {
      resumeThreadId,
      prompt,
      defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
      model,
      effort: request.effort,
      sandbox,
      onProgress: tracker.onProgress,
      persistThread: Boolean(entry),
      threadName: entry && !resumeThreadId ? buildRegisteredThreadName(entry.name) : null
    });
  } catch (error) {
    if (entry) {
      releaseFailedThread(workspaceRoot, request.jobId, tracker.threadId);
    }
    throw error;
  }

  if (entry) {
    const [released] = releaseThread(workspaceRoot, request.jobId, {
      threadId: result.threadId,
      lastPrompt: prompt || DEFAULT_CONTINUE_PROMPT,
      lastJobId: request.jobId,
      turnCompleted: result.status === 0
    });
    entry = released ?? entry;
  }

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = appendThreadBlock(
    renderTaskResult(
      {
        rawOutput,
        failureMessage,
        reasoningSummary: result.reasoningSummary
      },
      {
        title: taskMetadata.title,
        jobId: request.jobId ?? null,
        write: Boolean(request.write)
      }
    ),
    threadSummary(entry)
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    thread: threadSummary(entry),
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  const thread = payload.threadName ? ` on thread ${payload.threadName}` : "";
  return `${payload.title} started in the background as ${payload.jobId}${thread}. Check /cx:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}


function buildTaskRequest({
  cwd,
  model,
  effort,
  prompt,
  write,
  resumeLast,
  jobId,
  threadName = null,
  threadRef = null,
  ephemeral = false
}) {
  return { cwd, model, effort, prompt, write, resumeLast, jobId, threadName, threadRef, ephemeral };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "name"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  if (options.name) {
    validateThreadName(options.name);
  }
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        threadName: options.name ?? null,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

function validateTaskFlags(options) {
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  if (resumeLast && options.fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  if (options.name && options.thread) {
    throw new Error("Choose either --name (start a new thread) or --thread (continue one).");
  }
  if (options.thread && (options.fresh || resumeLast)) {
    throw new Error("--thread cannot be combined with --fresh or --resume-last.");
  }
  if (options.name && (resumeLast || options.ephemeral)) {
    throw new Error("--name cannot be combined with --resume-last or --ephemeral.");
  }
  if (options.thread && options.ephemeral) {
    throw new Error("--thread cannot be combined with --ephemeral.");
  }
  if (options.name) {
    validateThreadName(options.name);
  }
  return resumeLast;
}

async function launchTask({ cwd, workspaceRoot, options, prompt, resumeLast, threadName, threadRef, ephemeral, title, summary }) {
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const write = Boolean(options.write);
  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title,
    workspaceRoot,
    jobClass: "task",
    summary,
    write
  });
  const request = buildTaskRequest({
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId: job.id,
    threadName,
    threadRef,
    ephemeral
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast || Boolean(threadRef));
    const held = holdThreadForBackgroundJob(workspaceRoot, request);
    if (held) {
      job.threadName = held.name;
    }
    let payload;
    try {
      ({ payload } = enqueueBackgroundTask(cwd, job, request));
    } catch (error) {
      releaseThread(workspaceRoot, job.id, { dropIfUnstarted: true });
      throw error;
    }
    if (held) {
      payload.threadName = held.name;
    }
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) => executeTaskRun({ ...request, onProgress: progress }),
    { json: options.json }
  );
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "name", "thread"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "ephemeral"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const resumeLast = validateTaskFlags(options);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast: resumeLast || Boolean(options.thread) });

  await launchTask({
    cwd,
    workspaceRoot,
    options,
    prompt,
    resumeLast,
    threadName: options.name ?? null,
    threadRef: options.thread ?? null,
    ephemeral: Boolean(options.ephemeral),
    title: taskMetadata.title,
    summary: taskMetadata.summary
  });
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const candidate = findLatestThread(workspaceRoot, { kind: "task", includeBusy: false });
  const payload = {
    available: Boolean(candidate),
    sessionId: getCurrentClaudeSessionId(),
    candidate: candidate
      ? {
          name: candidate.name,
          threadId: candidate.threadId,
          kind: candidate.kind,
          updatedAt: candidate.updatedAt,
          lastPrompt: candidate.lastPrompt ?? "",
          lastJobId: candidate.lastJobId ?? null,
          ageLabel: formatRelativeTime(candidate.updatedAt)
        }
      : null
  };
  const rendered = candidate
    ? `Resumable thread found: ${candidate.name} (${payload.candidate.ageLabel}: "${payload.candidate.lastPrompt}").\n`
    : "No resumable Codex task thread in this repository.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleAsk(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const [threadRef, ...promptParts] = positionals;
  if (!threadRef) {
    throw new Error("Usage: ask <thread> <prompt>. Run /cx:threads to list known threads.");
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const entry = resolveThread(workspaceRoot, threadRef);
  const prompt = readTaskPrompt(cwd, options, promptParts);
  if (!prompt) {
    throw new Error(`Provide a question for thread "${entry.name}".`);
  }
  if (entry.kind === "review" && !NATIVE_REVIEW_FOLLOW_UP) {
    process.stderr.write(
      "Note: built-in reviews cannot see their own findings on follow-up. For a reviewer you can question, use /cx:adversarial-review --name <name>.\n"
    );
  }

  await launchTask({
    cwd,
    workspaceRoot,
    options,
    prompt,
    resumeLast: false,
    threadName: null,
    threadRef: entry.name,
    ephemeral: false,
    title: `Codex Ask ${entry.name}`,
    summary: shorten(prompt)
  });
}

function handleThreads(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const workspaceRoot = resolveCommandWorkspace(options);
  const threads = listThreads(workspaceRoot);
  outputCommandResult({ workspaceRoot, threads }, renderThreadsReport(threads), options.json);
}

function handleForget(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const name = positionals[0];
  if (!name) {
    throw new Error("Usage: forget <thread>. Run /cx:threads to list known threads.");
  }
  const workspaceRoot = resolveCommandWorkspace(options);
  const entry = forgetThread(workspaceRoot, name);
  const lines = [`Forgot thread ${entry.name}.`, "The Codex conversation itself is untouched."];
  if (entry.threadId) {
    lines.push(`Resume in Codex: codex resume ${entry.threadId}`);
  }
  outputCommandResult({ forgotten: entry }, `${lines.join("\n")}\n`, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });
  releaseFailedThread(workspaceRoot, job.id, threadId);

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "ask":
      await handleAsk(argv);
      break;
    case "threads":
      handleThreads(argv);
      break;
    case "forget":
      handleForget(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
