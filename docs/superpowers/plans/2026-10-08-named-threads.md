# Named Persistent Codex Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Code start several Codex conversations, keep them by name per repository, and send follow-up turns to any of them later with `/cx:ask <name> <question>`.

**Architecture:** A new file-backed thread registry (`threads.json`, beside upstream's `state.json`) records every non-ephemeral Codex thread the plugin starts. The two existing runners (`executeReviewRun`, `executeTaskRun`) reserve, lock and release registry entries, and a new `ask` subcommand resumes a named thread through the app server's `thread/resume` and `turn/start`. Slash commands, the rescue agent, and a new auto-triggered skill expose it to the user. The plugin is renamed `cx` so it installs beside upstream.

**Tech Stack:** Node.js 18.18+ ES modules, no runtime dependencies, `node --test` for tests, the Codex CLI's `codex app-server` JSON-RPC protocol (tested with Codex CLI 0.161.0).

**Spec:** `docs/superpowers/specs/2026-10-08-named-threads-design.md`

## Global Constraints

- Repository: `~/Documents/src/codex-plugin-cc`, branch `named-threads`, remote `origin` is `cannonpalms/codex-plugin-cc`, remote `upstream` is `openai/codex-plugin-cc`. Never push to `upstream`.
- The plugin directory stays `plugins/codex`. Only names and strings change in the rename.
- Command prefix is `/cx:`. The subagent is `cx:codex-rescue`. No file under `plugins/` or `README.md` may contain `/codex:` or `codex:codex-rescue` when done.
- Thread names match `^[a-z0-9][a-z0-9._-]{0,63}$`. Auto names are `review-N`, `adv-N`, `task-N`.
- Codex-side thread names are `cx:<name>`.
- Registry file is `threads.json` in the directory returned by `resolveStateDir(workspaceRoot)` from `plugins/codex/scripts/lib/state.mjs`. It is never deleted by the session-end hook.
- Test runner: `npm test` from the repository root. Baseline before this work: 91 tests, 90 pass, 1 fail. The failing test `collectReviewContext skips untracked directories in working tree review` in `tests/git.test.mjs` is upstream's, fails on this machine before any change, and stays out of every "all tests pass" check below. Every other test must pass at every commit.
- Commit messages: plain imperative subject, no tool attribution lines, no mention of AI assistance anywhere in commits, code or docs.
- Environment variable names (`CODEX_COMPANION_SESSION_ID`, `CLAUDE_PLUGIN_DATA`, broker variables) do not change.
- Do not add dependencies.
- No em dashes in any text. Use two hyphens.

## File map

Created:
- `plugins/codex/scripts/lib/threads.mjs` -- the registry: load, save, reserve, resolve, acquire, release, list, forget.
- `tests/threads.test.mjs` -- registry unit tests.
- `plugins/codex/commands/ask.md`, `threads.md`, `forget.md` -- slash commands.
- `plugins/codex/skills/cx-follow-up/SKILL.md` -- auto-triggered skill mapping "ask that reviewer..." to `ask`.
- `docs/superpowers/spikes/2026-10-08-native-review-follow-up.md` -- spike result (Task 1).

Modified:
- `plugins/codex/scripts/lib/codex.mjs` -- `runAppServerReview` learns `persistThread`; new `buildRegisteredThreadName`.
- `plugins/codex/scripts/lib/render.mjs` -- thread block, threads table, relative time, status thread column.
- `plugins/codex/scripts/codex-companion.mjs` -- flags, `ask`/`threads`/`forget` subcommands, registry calls in both runners, registry-backed resume candidate, cancel releases lock.
- `plugins/codex/scripts/stop-review-gate-hook.mjs` -- passes `--ephemeral`.
- `plugins/codex/commands/*.md`, `plugins/codex/agents/codex-rescue.md`, `plugins/codex/skills/*/SKILL.md`, `plugins/codex/prompts/stop-review-gate.md` -- prefix rename and new flags.
- `plugins/codex/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `package-lock.json` -- name `cx`, version 1.1.0.
- `tests/runtime.test.mjs`, `tests/commands.test.mjs` -- rename, rewritten session-scope tests, new behaviour tests.
- `README.md`, `plugins/codex/CHANGELOG.md`.

---

### Task 1: Spike -- can a native review thread answer follow-up questions?

This task talks to the real Codex CLI, not the fixture. It needs `codex` installed and logged in (`codex login status`). Its output is a written finding that Task 7 and Task 11 read. Nothing from this task is kept except the finding.

**Files:**
- Create: `docs/superpowers/spikes/2026-10-08-native-review-follow-up.md`

**Interfaces:**
- Produces: the constants `NATIVE_REVIEW_REGISTERS` (`"threadId"` or `"sourceThreadId"`) and `NATIVE_REVIEW_FOLLOW_UP` (`true` or `false`) recorded in the spike file. Task 7 copies them into `codex-companion.mjs`.

- [ ] **Step 1: Write the spike script in the scratch directory (not the repo)**

Create `/tmp/cx-spike/spike.mjs` with this content. It imports the plugin's own app-server client so it exercises exactly the calls the plugin makes.

```js
import path from "node:path";
import { CodexAppServerClient } from "/home/cannon/Documents/src/codex-plugin-cc/plugins/codex/scripts/lib/app-server.mjs";

const cwd = process.argv[2];
if (!cwd) {
  throw new Error("usage: node spike.mjs <repo-with-uncommitted-changes>");
}

function waitForTurn(client, threadIds) {
  return new Promise((resolve) => {
    const texts = [];
    client.setNotificationHandler((message) => {
      const tid = message.params?.threadId;
      if (message.method === "thread/started") {
        threadIds.add(message.params.thread.id);
      }
      if (message.method === "item/completed" && threadIds.has(tid)) {
        const item = message.params.item;
        if (item.type === "agentMessage") texts.push(item.text);
        if (item.type === "exitedReviewMode") texts.push(item.review);
      }
      if (message.method === "turn/completed" && threadIds.has(tid)) {
        resolve(texts.join("\n"));
      }
    });
  });
}

const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
try {
  const started = await client.request("thread/start", {
    cwd,
    model: null,
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "cx_spike",
    ephemeral: false
  });
  const sourceThreadId = started.thread.id;
  await client.request("thread/name/set", { threadId: sourceThreadId, name: "cx:spike" });

  const ids = new Set([sourceThreadId]);
  const reviewDone = waitForTurn(client, ids);
  const review = await client.request("review/start", {
    threadId: sourceThreadId,
    delivery: "inline",
    target: { type: "uncommittedChanges" }
  });
  const reviewText = await reviewDone;
  console.log("=== source thread", sourceThreadId);
  console.log("=== review thread", review.reviewThreadId);
  console.log("=== review output\n", reviewText.slice(0, 1500));

  for (const candidate of [sourceThreadId, review.reviewThreadId]) {
    if (!candidate) continue;
    await client.request("thread/resume", {
      threadId: candidate,
      cwd,
      model: null,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false
    });
    const followIds = new Set([candidate]);
    const followDone = waitForTurn(client, followIds);
    await client.request("turn/start", {
      threadId: candidate,
      input: [{ type: "text", text: "Elaborate on your first finding from the review you just did. Quote it first." }],
      model: null,
      effort: null,
      outputSchema: null
    });
    const answer = await followDone;
    console.log(`=== follow-up on ${candidate === sourceThreadId ? "SOURCE" : "REVIEW"} thread ${candidate}\n`, answer.slice(0, 1500));
  }
} finally {
  await client.close();
}
```

- [ ] **Step 2: Run it against a repository with a small uncommitted change**

```bash
mkdir -p /tmp/cx-spike && cd /tmp/cx-spike && git init -q spike-repo && cd spike-repo
printf 'export function add(a, b) {\n  return a + b;\n}\n' > math.js
git add math.js && git -c user.name=t -c user.email=t@t commit -qm init
printf 'export function add(a, b) {\n  return a - b;\n}\n' > math.js
cd /tmp/cx-spike && node spike.mjs /tmp/cx-spike/spike-repo
```

Expected: a review output that mentions the subtraction bug, then one or two follow-up answers. A follow-up "works" if it quotes or clearly refers to the finding about `a - b`. A follow-up fails if Codex says it has no prior review, or describes the file afresh without reference to a finding.

- [ ] **Step 3: Record the finding**

Write `docs/superpowers/spikes/2026-10-08-native-review-follow-up.md`:

```markdown
# Spike: native review follow-up

Date: <today>
Codex CLI: <output of `codex --version`>

## Result

- Source thread follow-up: <worked | failed> -- <one line of evidence>
- Review thread follow-up: <worked | failed | not separate (reviewThreadId equals source)> -- <one line>

## Decision

NATIVE_REVIEW_REGISTERS = "<threadId | sourceThreadId>"
NATIVE_REVIEW_FOLLOW_UP = <true | false>
```

Decision rule: if the source thread follow-up worked, `NATIVE_REVIEW_REGISTERS = "sourceThreadId"` and `NATIVE_REVIEW_FOLLOW_UP = true`. Else if the review thread follow-up worked, `"threadId"` and `true`. Else `"sourceThreadId"` and `false`.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/src/codex-plugin-cc
git add docs/superpowers/spikes/2026-10-08-native-review-follow-up.md
git commit -m "Record spike on native review follow-up turns"
```

---

### Task 2: Rename the plugin to `cx`

Mechanical. Every `/codex:` becomes `/cx:`, every `codex:codex-rescue` becomes `cx:codex-rescue`, the manifests say `cx`, and a test guards against regressions.

**Files:**
- Modify: `plugins/codex/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Modify: every file listed by `grep -rl '/codex:\|codex:codex-rescue' plugins README.md tests`
- Test: `tests/commands.test.mjs`

**Interfaces:**
- Produces: the strings `/cx:` and `cx:codex-rescue` used by every later task.

- [ ] **Step 1: Write the failing guard test**

Append to `tests/commands.test.mjs`:

```js
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".generated") continue;
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

test("no plugin file still uses the upstream codex prefix", () => {
  const files = [...walk(PLUGIN_ROOT), path.join(ROOT, "README.md")];
  const offenders = files.filter((file) => {
    const text = fs.readFileSync(file, "utf8");
    return /\/codex:/.test(text) || /codex:codex-rescue/.test(text);
  });
  assert.deepEqual(offenders.map((file) => path.relative(ROOT, file)), []);
});

test("plugin and marketplace manifests are named cx", () => {
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  assert.equal(plugin.name, "cx");
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(marketplace.name, "cx");
  assert.equal(marketplace.plugins[0].name, "cx");
  assert.equal(marketplace.plugins[0].source, "./plugins/codex");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/commands.test.mjs`
Expected: both new tests FAIL, the first listing many offenders.

- [ ] **Step 3: Apply the rename**

```bash
cd ~/Documents/src/codex-plugin-cc
grep -rl '/codex:\|codex:codex-rescue' plugins README.md tests | xargs sed -i 's#/codex:#/cx:#g; s#codex:codex-rescue#cx:codex-rescue#g'
```

Then edit `plugins/codex/.claude-plugin/plugin.json` so `"name": "cx"` and the description reads `"Use Codex from Claude Code with named, resumable threads: review, delegate, then ask follow-ups."`. Edit `.claude-plugin/marketplace.json` so the top-level `"name"` is `"cx"`, `owner.name` is `"Cannon Palms"`, `metadata.description` is `"Codex plugin for Claude Code with named, resumable threads."`, and the plugin entry's `"name"` is `"cx"` with the same description as plugin.json. Leave both versions at 1.0.6 for now; Task 11 bumps them.

In `README.md` replace the install block so it reads:

```bash
/plugin marketplace add cannonpalms/codex-plugin-cc
/plugin install cx@cx
/reload-plugins
/cx:setup
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)|^✖ '`
Expected: `fail 1`, and the only `✖` line is `collectReviewContext skips untracked directories in working tree review`. Several existing tests in `tests/commands.test.mjs` assert on `/codex:` text; the sed above also updated those assertions, so they pass.

- [ ] **Step 5: Commit**

```bash
git add -A plugins README.md tests .claude-plugin
git commit -m "Rename plugin and command prefix to cx"
```

---

### Task 3: Thread registry module

**Files:**
- Create: `plugins/codex/scripts/lib/threads.mjs`
- Test: `tests/threads.test.mjs`

**Interfaces:**
- Consumes: `resolveStateDir`, `ensureStateDir`, `listJobs`, `upsertJob` from `plugins/codex/scripts/lib/state.mjs` (existing).
- Produces, all synchronous:
  - `THREAD_KINDS` -- `["review", "adversarial-review", "task"]`
  - `validateThreadName(name) -> string`
  - `loadRegistry(workspaceRoot) -> { version: 1, counters: {}, threads: [] }`
  - `saveRegistry(workspaceRoot, registry)`
  - `resolveRegistryFile(workspaceRoot) -> string`
  - `reserveThread(workspaceRoot, { name?, kind, sandbox, model?, sessionId?, jobId, prompt? }) -> entry`
  - `resolveThread(workspaceRoot, reference) -> entry`
  - `acquireThread(workspaceRoot, name, jobId) -> entry`
  - `releaseThread(workspaceRoot, jobId, patch?) -> entry[]` where patch may hold `threadId`, `lastPrompt`, `lastJobId`, `turnCompleted: true`, `dropIfUnstarted: true`
  - `listThreads(workspaceRoot) -> entry[]` newest first, each with a computed `busy` boolean
  - `findLatestThread(workspaceRoot, { kind?, includeBusy? }) -> entry | null`
  - `forgetThread(workspaceRoot, name) -> entry`
  - An entry is `{ name, threadId, kind, sandbox, model, createdAt, updatedAt, createdBySession, lastPrompt, lastJobId, turns, activeJobId }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/threads.test.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir, upsertJob, saveState, loadState } from "../plugins/codex/scripts/lib/state.mjs";
import {
  acquireThread,
  findLatestThread,
  forgetThread,
  listThreads,
  loadRegistry,
  releaseThread,
  reserveThread,
  resolveRegistryFile,
  resolveThread,
  validateThreadName
} from "../plugins/codex/scripts/lib/threads.mjs";

process.env.CLAUDE_PLUGIN_DATA = makeTempDir("cx-threads-data-");

function workspace() {
  return makeTempDir("cx-threads-ws-");
}

test("validateThreadName accepts the documented pattern and rejects the rest", () => {
  assert.equal(validateThreadName("review-1"), "review-1");
  assert.equal(validateThreadName(" auth.fix_2 "), "auth.fix_2");
  assert.throws(() => validateThreadName("Review"), /Invalid thread name/);
  assert.throws(() => validateThreadName("-bad"), /Invalid thread name/);
  assert.throws(() => validateThreadName(""), /Invalid thread name/);
  assert.throws(() => validateThreadName("a".repeat(65)), /Invalid thread name/);
});

test("reserveThread auto-names per kind and never reuses a counter", () => {
  const ws = workspace();
  const first = reserveThread(ws, { kind: "review", sandbox: "read-only", jobId: "job-1" });
  const second = reserveThread(ws, { kind: "adversarial-review", sandbox: "read-only", jobId: "job-2" });
  const third = reserveThread(ws, { kind: "task", sandbox: "workspace-write", jobId: "job-3" });
  assert.equal(first.name, "review-1");
  assert.equal(second.name, "adv-1");
  assert.equal(third.name, "task-1");
  assert.equal(first.activeJobId, "job-1");
  assert.equal(first.threadId, null);
  assert.equal(first.turns, 0);

  releaseThread(ws, "job-1", { threadId: "thr_a", turnCompleted: true });
  forgetThread(ws, "review-1");
  const fourth = reserveThread(ws, { kind: "review", sandbox: "read-only", jobId: "job-4" });
  assert.equal(fourth.name, "review-2");
});

test("reserveThread skips an auto name the user already took", () => {
  const ws = workspace();
  reserveThread(ws, { name: "task-1", kind: "task", sandbox: "read-only", jobId: "job-1" });
  const auto = reserveThread(ws, { kind: "task", sandbox: "read-only", jobId: "job-2" });
  assert.equal(auto.name, "task-2");
});

test("reserveThread rejects a duplicate explicit name", () => {
  const ws = workspace();
  reserveThread(ws, { name: "auth", kind: "task", sandbox: "read-only", jobId: "job-1" });
  assert.throws(
    () => reserveThread(ws, { name: "auth", kind: "task", sandbox: "read-only", jobId: "job-2" }),
    /A thread named "auth" already exists/
  );
});

test("releaseThread records the thread id, prompt and turn count and clears the lock", () => {
  const ws = workspace();
  reserveThread(ws, { name: "auth", kind: "task", sandbox: "read-only", jobId: "job-1", prompt: "first" });
  const [released] = releaseThread(ws, "job-1", { threadId: "thr_1", lastPrompt: "first", lastJobId: "job-1", turnCompleted: true });
  assert.equal(released.threadId, "thr_1");
  assert.equal(released.activeJobId, null);
  assert.equal(released.turns, 1);
  assert.equal(released.lastPrompt, "first");
  assert.equal(released.lastJobId, "job-1");
});

test("releaseThread with dropIfUnstarted removes an entry that never got a thread id", () => {
  const ws = workspace();
  reserveThread(ws, { name: "doomed", kind: "task", sandbox: "read-only", jobId: "job-1" });
  releaseThread(ws, "job-1", { dropIfUnstarted: true });
  assert.deepEqual(listThreads(ws), []);
});

test("resolveThread matches exact name, then unique thread id prefix", () => {
  const ws = workspace();
  reserveThread(ws, { name: "alpha", kind: "task", sandbox: "read-only", jobId: "job-1" });
  releaseThread(ws, "job-1", { threadId: "0123456789abcdef", turnCompleted: true });
  reserveThread(ws, { name: "beta", kind: "task", sandbox: "read-only", jobId: "job-2" });
  releaseThread(ws, "job-2", { threadId: "0123456aaaaaaaaa", turnCompleted: true });

  assert.equal(resolveThread(ws, "alpha").name, "alpha");
  assert.equal(resolveThread(ws, "0123456789").name, "alpha");
  assert.throws(() => resolveThread(ws, "0123456"), /ambiguous/);
  assert.throws(() => resolveThread(ws, "gamma"), /No thread named "gamma"\. Known threads: beta, alpha\. Run \/cx:threads\./);
  assert.throws(() => resolveThread(ws, ""), /Thread name is required/);
});

test("resolveThread on an empty registry explains how to start one", () => {
  const ws = workspace();
  assert.throws(() => resolveThread(ws, "x"), /No Codex threads are registered in this repository yet/);
});

test("acquireThread rejects a thread whose job is still running", () => {
  const ws = workspace();
  reserveThread(ws, { name: "busy", kind: "task", sandbox: "read-only", jobId: "job-1" });
  releaseThread(ws, "job-1", { threadId: "thr_1", turnCompleted: true });
  acquireThread(ws, "busy", "job-2");
  upsertJob(ws, { id: "job-2", status: "running", jobClass: "task" });
  assert.throws(() => acquireThread(ws, "busy", "job-3"), /Thread "busy" is busy with job job-2/);
});

test("acquireThread clears a stale lock whose job finished or is missing", () => {
  const ws = workspace();
  reserveThread(ws, { name: "stale", kind: "task", sandbox: "read-only", jobId: "job-1" });
  releaseThread(ws, "job-1", { threadId: "thr_1", turnCompleted: true });
  acquireThread(ws, "stale", "job-missing");
  const entry = acquireThread(ws, "stale", "job-2");
  assert.equal(entry.activeJobId, "job-2");

  upsertJob(ws, { id: "job-2", status: "completed", jobClass: "task" });
  const again = acquireThread(ws, "stale", "job-3");
  assert.equal(again.activeJobId, "job-3");
});

test("acquireThread refuses a thread that never received a thread id", () => {
  const ws = workspace();
  reserveThread(ws, { name: "half", kind: "task", sandbox: "read-only", jobId: "job-1" });
  releaseThread(ws, "job-1");
  assert.throws(() => acquireThread(ws, "half", "job-2"), /never received a Codex thread id/);
});

test("listThreads is newest first and marks busy threads", () => {
  const ws = workspace();
  reserveThread(ws, { name: "old", kind: "review", sandbox: "read-only", jobId: "job-1" });
  releaseThread(ws, "job-1", { threadId: "thr_1", turnCompleted: true });
  const registry = loadRegistry(ws);
  registry.threads.find((t) => t.name === "old").updatedAt = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(resolveRegistryFile(ws), JSON.stringify(registry));

  reserveThread(ws, { name: "new", kind: "task", sandbox: "read-only", jobId: "job-2" });
  upsertJob(ws, { id: "job-2", status: "running", jobClass: "task" });

  const threads = listThreads(ws);
  assert.deepEqual(threads.map((t) => t.name), ["new", "old"]);
  assert.equal(threads[0].busy, true);
  assert.equal(threads[1].busy, false);
});

test("findLatestThread filters by kind and skips busy threads unless asked", () => {
  const ws = workspace();
  reserveThread(ws, { name: "r", kind: "review", sandbox: "read-only", jobId: "job-1" });
  releaseThread(ws, "job-1", { threadId: "thr_r", turnCompleted: true });
  reserveThread(ws, { name: "t", kind: "task", sandbox: "read-only", jobId: "job-2" });
  releaseThread(ws, "job-2", { threadId: "thr_t", turnCompleted: true });
  acquireThread(ws, "t", "job-3");
  upsertJob(ws, { id: "job-3", status: "running", jobClass: "task" });

  assert.equal(findLatestThread(ws, { kind: "task" }), null);
  assert.equal(findLatestThread(ws, { kind: "task", includeBusy: true }).name, "t");
  assert.equal(findLatestThread(ws, { kind: "review" }).name, "r");
  assert.equal(findLatestThread(ws).name, "r");
});

test("forgetThread removes an idle entry and refuses a busy one", () => {
  const ws = workspace();
  reserveThread(ws, { name: "a", kind: "task", sandbox: "read-only", jobId: "job-1" });
  releaseThread(ws, "job-1", { threadId: "thr_a", turnCompleted: true });
  const gone = forgetThread(ws, "a");
  assert.equal(gone.threadId, "thr_a");
  assert.deepEqual(listThreads(ws), []);
  assert.throws(() => forgetThread(ws, "a"), /No thread named "a"/);

  reserveThread(ws, { name: "b", kind: "task", sandbox: "read-only", jobId: "job-2" });
  upsertJob(ws, { id: "job-2", status: "running", jobClass: "task" });
  assert.throws(() => forgetThread(ws, "b"), /Thread "b" is busy with job job-2/);
});

test("the registry survives saveState and lives beside state.json", () => {
  const ws = workspace();
  reserveThread(ws, { name: "keep", kind: "task", sandbox: "read-only", jobId: "job-1" });
  saveState(ws, { ...loadState(ws), jobs: [] });
  assert.equal(path.dirname(resolveRegistryFile(ws)), resolveStateDir(ws));
  assert.equal(listThreads(ws)[0].name, "keep");
});

test("loadRegistry tolerates a corrupt file", () => {
  const ws = workspace();
  fs.mkdirSync(resolveStateDir(ws), { recursive: true });
  fs.writeFileSync(resolveRegistryFile(ws), "{not json");
  assert.deepEqual(loadRegistry(ws), { version: 1, counters: {}, threads: [] });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/threads.test.mjs`
Expected: FAIL at import, module `threads.mjs` not found.

- [ ] **Step 3: Write the module**

Create `plugins/codex/scripts/lib/threads.mjs`:

```js
import fs from "node:fs";
import path from "node:path";

import { ensureStateDir, listJobs, resolveStateDir } from "./state.mjs";

const REGISTRY_VERSION = 1;
const REGISTRY_FILE_NAME = "threads.json";
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KIND_PREFIXES = {
  review: "review",
  "adversarial-review": "adv",
  task: "task"
};
const PROMPT_EXCERPT_LIMIT = 120;

export const THREAD_KINDS = Object.keys(KIND_PREFIXES);

function nowIso() {
  return new Date().toISOString();
}

function excerpt(text) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= PROMPT_EXCERPT_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, PROMPT_EXCERPT_LIMIT - 3)}...`;
}

function defaultRegistry() {
  return { version: REGISTRY_VERSION, counters: {}, threads: [] };
}

export function resolveRegistryFile(workspaceRoot) {
  return path.join(resolveStateDir(workspaceRoot), REGISTRY_FILE_NAME);
}

export function loadRegistry(workspaceRoot) {
  const file = resolveRegistryFile(workspaceRoot);
  if (!fs.existsSync(file)) {
    return defaultRegistry();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: REGISTRY_VERSION,
      counters: parsed.counters && typeof parsed.counters === "object" ? parsed.counters : {},
      threads: Array.isArray(parsed.threads) ? parsed.threads : []
    };
  } catch {
    return defaultRegistry();
  }
}

export function saveRegistry(workspaceRoot, registry) {
  ensureStateDir(workspaceRoot);
  fs.writeFileSync(resolveRegistryFile(workspaceRoot), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return registry;
}

function updateRegistry(workspaceRoot, mutate) {
  const registry = loadRegistry(workspaceRoot);
  const result = mutate(registry);
  saveRegistry(workspaceRoot, registry);
  return result;
}

export function validateThreadName(name) {
  const value = String(name ?? "").trim();
  if (!NAME_PATTERN.test(value)) {
    throw new Error(
      `Invalid thread name "${name}". Use 1-64 characters: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.`
    );
  }
  return value;
}

function isJobActive(workspaceRoot, jobId) {
  if (!jobId) {
    return false;
  }
  const job = listJobs(workspaceRoot).find((candidate) => candidate.id === jobId);
  return Boolean(job && (job.status === "queued" || job.status === "running"));
}

function nextAutoName(registry, kind) {
  const prefix = KIND_PREFIXES[kind];
  let candidate;
  do {
    const next = (registry.counters[prefix] ?? 0) + 1;
    registry.counters[prefix] = next;
    candidate = `${prefix}-${next}`;
  } while (registry.threads.some((thread) => thread.name === candidate));
  return candidate;
}

export function reserveThread(workspaceRoot, { name, kind, sandbox, model = null, sessionId = null, jobId, prompt = "" }) {
  if (!KIND_PREFIXES[kind]) {
    throw new Error(`Unknown thread kind "${kind}".`);
  }
  if (!jobId) {
    throw new Error("reserveThread requires a jobId.");
  }
  return updateRegistry(workspaceRoot, (registry) => {
    let chosen;
    if (name) {
      chosen = validateThreadName(name);
      if (registry.threads.some((thread) => thread.name === chosen)) {
        throw new Error(
          `A thread named "${chosen}" already exists. Use /cx:ask ${chosen} to continue it, /cx:forget ${chosen} to drop it, or pick another name.`
        );
      }
    } else {
      chosen = nextAutoName(registry, kind);
    }
    const timestamp = nowIso();
    const entry = {
      name: chosen,
      threadId: null,
      kind,
      sandbox,
      model: model ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBySession: sessionId ?? null,
      lastPrompt: excerpt(prompt),
      lastJobId: jobId,
      turns: 0,
      activeJobId: jobId
    };
    registry.threads.unshift(entry);
    return { ...entry };
  });
}

export function resolveThread(workspaceRoot, reference) {
  const ref = String(reference ?? "").trim();
  if (!ref) {
    throw new Error("Thread name is required. Run /cx:threads to list known threads.");
  }
  const registry = loadRegistry(workspaceRoot);
  const exact = registry.threads.find((thread) => thread.name === ref);
  if (exact) {
    return { ...exact };
  }
  if (ref.length >= 6) {
    const matches = registry.threads.filter((thread) => thread.threadId && thread.threadId.startsWith(ref));
    if (matches.length === 1) {
      return { ...matches[0] };
    }
    if (matches.length > 1) {
      throw new Error(`Thread id prefix "${ref}" is ambiguous. Use a longer prefix or the thread name.`);
    }
  }
  const known = registry.threads.map((thread) => thread.name);
  if (known.length === 0) {
    throw new Error(
      `No thread named "${ref}". No Codex threads are registered in this repository yet. Start one with /cx:review --name <name>, /cx:adversarial-review --name <name>, or /cx:rescue --name <name>.`
    );
  }
  throw new Error(`No thread named "${ref}". Known threads: ${known.join(", ")}. Run /cx:threads.`);
}

export function acquireThread(workspaceRoot, name, jobId) {
  return updateRegistry(workspaceRoot, (registry) => {
    const entry = registry.threads.find((thread) => thread.name === name);
    if (!entry) {
      throw new Error(`No thread named "${name}". Run /cx:threads to list known threads.`);
    }
    if (entry.activeJobId && entry.activeJobId !== jobId && isJobActive(workspaceRoot, entry.activeJobId)) {
      throw new Error(
        `Thread "${name}" is busy with job ${entry.activeJobId}. Check /cx:status ${entry.activeJobId} or /cx:cancel ${entry.activeJobId} first.`
      );
    }
    if (!entry.threadId) {
      throw new Error(
        `Thread "${name}" never received a Codex thread id; its first run failed. Run /cx:forget ${name} and start it again.`
      );
    }
    entry.activeJobId = jobId;
    entry.updatedAt = nowIso();
    return { ...entry };
  });
}

export function releaseThread(workspaceRoot, jobId, patch = {}) {
  return updateRegistry(workspaceRoot, (registry) => {
    const released = [];
    for (const entry of registry.threads) {
      if (entry.activeJobId !== jobId) {
        continue;
      }
      entry.activeJobId = null;
      if (patch.threadId) {
        entry.threadId = patch.threadId;
      }
      if (patch.lastPrompt !== undefined) {
        entry.lastPrompt = excerpt(patch.lastPrompt);
      }
      if (patch.lastJobId) {
        entry.lastJobId = patch.lastJobId;
      }
      if (patch.turnCompleted) {
        entry.turns += 1;
      }
      entry.updatedAt = nowIso();
      released.push({ ...entry });
    }
    if (patch.dropIfUnstarted) {
      const releasedNames = new Set(released.map((entry) => entry.name));
      registry.threads = registry.threads.filter((entry) => !(releasedNames.has(entry.name) && !entry.threadId));
    }
    return released;
  });
}

export function listThreads(workspaceRoot) {
  const registry = loadRegistry(workspaceRoot);
  return [...registry.threads]
    .map((entry) => ({
      ...entry,
      busy: Boolean(entry.activeJobId && isJobActive(workspaceRoot, entry.activeJobId))
    }))
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

export function findLatestThread(workspaceRoot, { kind = null, includeBusy = false } = {}) {
  return (
    listThreads(workspaceRoot).find(
      (entry) => entry.threadId && (!kind || entry.kind === kind) && (includeBusy || !entry.busy)
    ) ?? null
  );
}

export function forgetThread(workspaceRoot, name) {
  return updateRegistry(workspaceRoot, (registry) => {
    const entry = registry.threads.find((thread) => thread.name === name);
    if (!entry) {
      throw new Error(`No thread named "${name}". Run /cx:threads to list known threads.`);
    }
    if (entry.activeJobId && isJobActive(workspaceRoot, entry.activeJobId)) {
      throw new Error(
        `Thread "${name}" is busy with job ${entry.activeJobId}. Cancel it with /cx:cancel ${entry.activeJobId} before forgetting the thread.`
      );
    }
    registry.threads = registry.threads.filter((thread) => thread !== entry);
    return { ...entry };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/threads.test.mjs`
Expected: all 16 PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/lib/threads.mjs tests/threads.test.mjs
git commit -m "Add per-repository thread registry"
```

---

### Task 4: `runAppServerReview` can persist and name its thread

**Files:**
- Modify: `plugins/codex/scripts/lib/codex.mjs` (function `runAppServerReview`, near line 1002, and the exports at the bottom)
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: `startThread(client, cwd, { model, sandbox, ephemeral, threadName })` (existing, private).
- Produces: `runAppServerReview(cwd, { target, model, onProgress, persistThread?, threadName? })`; `buildRegisteredThreadName(name) -> "cx:<name>"` exported.

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime.test.mjs`:

```js
test("runAppServerReview persists and names the thread when asked", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "x\n");

  const { runAppServerReview, buildRegisteredThreadName } = await import("../plugins/codex/scripts/lib/codex.mjs");
  const previousPath = process.env.PATH;
  process.env.PATH = buildEnv(binDir).PATH;
  try {
    const result = await runAppServerReview(repo, {
      target: { type: "uncommittedChanges" },
      persistThread: true,
      threadName: buildRegisteredThreadName("review-9")
    });
    assert.equal(result.status, 0);
    const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const thread = fakeState.threads.find((t) => t.id === result.sourceThreadId);
    assert.equal(thread.ephemeral, false);
    assert.equal(thread.name, "cx:review-9");
  } finally {
    process.env.PATH = previousPath;
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/runtime.test.mjs --test-name-pattern "persists and names"`
Expected: FAIL, `buildRegisteredThreadName` is not exported (TypeError) or `thread.ephemeral` is `true`.

- [ ] **Step 3: Implement**

In `codex.mjs`, inside `runAppServerReview`, change the `startThread` call from:

```js
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
```

to:

```js
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: !options.persistThread,
      threadName: options.threadName ?? null
    });
```

Add after `buildTaskThreadName`:

```js
export function buildRegisteredThreadName(name) {
  return `cx:${name}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/runtime.test.mjs --test-name-pattern "persists and names"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/lib/codex.mjs tests/runtime.test.mjs
git commit -m "Let native reviews run on persistent named threads"
```

---

### Task 5: Renderer additions

**Files:**
- Modify: `plugins/codex/scripts/lib/render.mjs`
- Test: `tests/render.test.mjs`

**Interfaces:**
- Produces, exported from `render.mjs`:
  - `formatRelativeTime(iso, now = Date.now()) -> string`
  - `renderThreadBlock(thread) -> string` (empty string when `thread` lacks `name` or `threadId`)
  - `appendThreadBlock(rendered, thread) -> string`
  - `renderThreadsReport(threads) -> string`
  - `renderStoredJobResult` now prefers `storedJob.result.thread` for its footer.
  - `pushJobDetails` prints `Thread:` and `Follow up:` lines when `job.threadName` is set.

- [ ] **Step 1: Write the failing tests**

Append to `tests/render.test.mjs` (check its existing imports first; add the new names to the existing import from `../plugins/codex/scripts/lib/render.mjs`):

```js
test("formatRelativeTime buckets into minutes, hours and days", () => {
  const now = Date.parse("2026-10-08T12:00:00.000Z");
  assert.equal(formatRelativeTime("2026-10-08T11:59:40.000Z", now), "just now");
  assert.equal(formatRelativeTime("2026-10-08T11:45:00.000Z", now), "15 min ago");
  assert.equal(formatRelativeTime("2026-10-08T10:00:00.000Z", now), "2 hours ago");
  assert.equal(formatRelativeTime("2026-10-08T11:00:00.000Z", now), "1 hour ago");
  assert.equal(formatRelativeTime("2026-10-05T12:00:00.000Z", now), "3 days ago");
  assert.equal(formatRelativeTime("garbage", now), "");
});

test("renderThreadBlock and appendThreadBlock add the follow-up footer", () => {
  const thread = { name: "review-3", threadId: "thr_3" };
  assert.equal(
    renderThreadBlock(thread),
    "Thread: review-3 (thr_3)\nFollow up: /cx:ask review-3 <question>\nResume in Codex: codex resume thr_3\n"
  );
  assert.equal(renderThreadBlock(null), "");
  assert.equal(renderThreadBlock({ name: "x" }), "");
  assert.equal(appendThreadBlock("body", thread), "body\n\nThread: review-3 (thr_3)\nFollow up: /cx:ask review-3 <question>\nResume in Codex: codex resume thr_3\n");
  assert.equal(appendThreadBlock("body\n", null), "body\n");
});

test("renderThreadsReport lists threads newest first with state and hints", () => {
  const empty = renderThreadsReport([]);
  assert.match(empty, /No Codex threads in this repository\./);
  assert.match(empty, /\/cx:review --name/);

  const report = renderThreadsReport([
    { name: "task-2", kind: "task", busy: true, activeJobId: "task-abc", threadId: "thr_2", turns: 3, updatedAt: new Date().toISOString(), lastPrompt: "apply the top fix" },
    { name: "review-1", kind: "review", busy: false, threadId: "thr_1", turns: 1, updatedAt: new Date(Date.now() - 3600_000).toISOString(), lastPrompt: "Review main...HEAD" },
    { name: "half", kind: "task", busy: false, threadId: null, turns: 0, updatedAt: new Date().toISOString(), lastPrompt: "" }
  ]);
  assert.match(report, /\| Thread \| Kind \| State \| Turns \| Updated \| Last prompt \|/);
  assert.match(report, /\| task-2 \| task \| busy task-abc \| 3 \| just now \| apply the top fix \|/);
  assert.match(report, /\| review-1 \| review \| idle \| 1 \| 1 hour ago \| Review main\.\.\.HEAD \|/);
  assert.match(report, /\| half \| task \| starting \| 0 \|/);
  assert.match(report, /Follow up: \/cx:ask <thread> <question>/);
});

test("renderStoredJobResult uses the thread block when the stored result has a thread", () => {
  const output = renderStoredJobResult(
    { id: "task-1", status: "completed", threadId: "thr_1" },
    { threadId: "thr_1", result: { rawOutput: "done", thread: { name: "task-1", threadId: "thr_1" } } }
  );
  assert.equal(output, "done\n\nThread: task-1 (thr_1)\nFollow up: /cx:ask task-1 <question>\nResume in Codex: codex resume thr_1\n");
});

test("renderJobStatusReport shows the thread name and follow-up when present", () => {
  const output = renderJobStatusReport({ id: "task-1", status: "completed", threadId: "thr_1", threadName: "auth" });
  assert.match(output, /Thread: auth/);
  assert.match(output, /Follow up: \/cx:ask auth <question>/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/render.test.mjs`
Expected: FAIL, the new functions are not exported.

- [ ] **Step 3: Implement**

In `render.mjs` add after `escapeMarkdownCell`:

```js
function shortenCell(text, limit) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

export function formatRelativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "";
  }
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function renderThreadBlock(thread) {
  if (!thread?.name || !thread?.threadId) {
    return "";
  }
  return [
    `Thread: ${thread.name} (${thread.threadId})`,
    `Follow up: /cx:ask ${thread.name} <question>`,
    `Resume in Codex: codex resume ${thread.threadId}`
  ].join("\n") + "\n";
}

export function appendThreadBlock(rendered, thread) {
  const block = renderThreadBlock(thread);
  if (!block) {
    return rendered;
  }
  const base = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  return `${base}\n${block}`;
}

export function renderThreadsReport(threads) {
  if (threads.length === 0) {
    return [
      "No Codex threads in this repository.",
      "Start one with /cx:review --name <name>, /cx:adversarial-review --name <name>, or /cx:rescue --name <name>."
    ].join("\n") + "\n";
  }
  const lines = [
    "# Codex Threads",
    "",
    "| Thread | Kind | State | Turns | Updated | Last prompt |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  for (const thread of threads) {
    const state = thread.busy ? `busy ${thread.activeJobId}` : thread.threadId ? "idle" : "starting";
    lines.push(
      `| ${escapeMarkdownCell(thread.name)} | ${escapeMarkdownCell(thread.kind)} | ${escapeMarkdownCell(state)} | ${thread.turns ?? 0} | ${escapeMarkdownCell(formatRelativeTime(thread.updatedAt))} | ${escapeMarkdownCell(shortenCell(thread.lastPrompt, 48))} |`
    );
  }
  lines.push("", "Follow up: /cx:ask <thread> <question>");
  return `${lines.join("\n")}\n`;
}
```

In `pushJobDetails`, directly after the `Resume in Codex` lines (after `if (resumeCommand) {...}`), add:

```js
  if (job.threadName) {
    lines.push(`  Thread: ${job.threadName}`);
    lines.push(`  Follow up: /cx:ask ${job.threadName} <question>`);
  }
```

In `appendActiveJobsTable`, add a `Thread` column: header becomes
`"| Job | Kind | Status | Phase | Elapsed | Thread | Codex Session ID | Summary | Actions |"`, the separator gets one more `| --- `, and the row inserts `${escapeMarkdownCell(job.threadName ?? "")}` between the elapsed and thread id cells.

In `renderStoredJobResult`, add at the top:

```js
  const thread = storedJob?.result?.thread ?? null;
```

and define a local helper above the function:

```js
function appendSessionFooter(output, threadId, thread) {
  if (thread?.name && thread?.threadId) {
    return appendThreadBlock(output, thread);
  }
  if (!threadId) {
    return output;
  }
  return `${output}\nCodex session ID: ${threadId}\nResume in Codex: codex resume ${threadId}\n`;
}
```

Then replace each of the three blocks of the form

```js
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
```

with `return appendSessionFooter(output, threadId, thread);`. In the final fallback branch, after the `Codex session ID` lines, add:

```js
  if (thread?.name) {
    lines.push(`Thread: ${thread.name}`);
    lines.push(`Follow up: /cx:ask ${thread.name} <question>`);
  }
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/render.test.mjs`
Expected: all PASS, including the pre-existing render tests. If an existing test asserted the exact status table header, update it to the new header with the `Thread` column.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/lib/render.mjs tests/render.test.mjs
git commit -m "Render thread names, follow-up hints and a threads table"
```

---

### Task 6: Task runner registers, resumes and locks threads

This is the core change. `handleTask` gains `--name`, `--thread`, `--ephemeral`; `executeTaskRun` talks to the registry; `--resume-last` and `task-resume-candidate` become registry-backed; cancel releases the lock. Two upstream tests change meaning per the spec.

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs`
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: everything from Task 3 and `appendThreadBlock`, `formatRelativeTime` from Task 5, `buildRegisteredThreadName` from Task 4.
- Produces: `task` request objects carry `threadName`, `threadRef`, `ephemeral`; `executeTaskRun` returns `payload.thread = { name, threadId } | null`; jobs get `threadName`; `task-resume-candidate --json` returns `{ available, sessionId, candidate: { name, threadId, kind, updatedAt, lastPrompt, lastJobId, ageLabel } | null }`.

- [ ] **Step 1: Rewrite the two upstream tests whose meaning changed, and add the new ones**

In `tests/runtime.test.mjs`, replace the body of `test("task --resume-last does not resume a task from another Claude session", ...)` with this test (rename it too):

```js
test("task --resume-last resumes a finished task thread from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-other" };
  const currentEnv = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-current" };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env: otherEnv });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: repo, env: currentEnv });
  assert.equal(candidate.status, 0, candidate.stderr);
  const candidatePayload = JSON.parse(candidate.stdout);
  assert.equal(candidatePayload.available, true);
  assert.equal(candidatePayload.candidate.name, "task-1");
  assert.equal(candidatePayload.candidate.threadId, "thr_1");
  assert.equal(candidatePayload.candidate.lastPrompt, "initial task");
  assert.equal(candidatePayload.candidate.ageLabel, "just now");

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env: currentEnv });
  assert.equal(resume.status, 0, resume.stderr);
  assert.match(resume.stdout, /Resumed the prior run\./);
  assert.match(resume.stdout, /Thread: task-1 \(thr_1\)/);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});
```

Replace the body of `test("task --resume-last ignores running tasks from other Claude sessions", ...)` with (rename it too):

```js
test("task --resume-last refuses a task thread that is busy in another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        { id: "task-other-running", status: "running", title: "Codex Task", jobClass: "task", sessionId: "sess-other", threadId: "thr_other", summary: "Other session active task", updatedAt: "2026-03-24T20:05:00.000Z" }
      ]
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "threads.json"),
    `${JSON.stringify({
      version: 1,
      counters: { task: 1 },
      threads: [
        { name: "task-1", threadId: "thr_other", kind: "task", sandbox: "read-only", model: null, createdAt: "2026-03-24T20:00:00.000Z", updatedAt: "2026-03-24T20:05:00.000Z", createdBySession: "sess-other", lastPrompt: "Other session active task", lastJobId: "task-other-running", turns: 0, activeJobId: "task-other-running" }
      ]
    }, null, 2)}\n`,
    "utf8"
  );

  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-current" };
  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: repo, env });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /Thread "task-1" is busy with job task-other-running/);
});
```

Replace `test("task-resume-candidate returns the latest rescue thread from the current session", ...)` entirely with:

```js
test("task-resume-candidate returns the latest idle task thread across sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "threads.json"),
    `${JSON.stringify({
      version: 1,
      counters: { task: 2, review: 1 },
      threads: [
        { name: "review-1", threadId: "thr_review", kind: "review", sandbox: "read-only", model: null, createdAt: "2026-03-24T20:10:00.000Z", updatedAt: "2026-03-24T20:10:00.000Z", createdBySession: "sess-current", lastPrompt: "Review main...HEAD", lastJobId: "review-current", turns: 1, activeJobId: null },
        { name: "task-2", threadId: "thr_other", kind: "task", sandbox: "read-only", model: null, createdAt: "2026-03-24T20:05:00.000Z", updatedAt: "2026-03-24T20:05:00.000Z", createdBySession: "sess-other", lastPrompt: "Old rescue run", lastJobId: "task-other-session", turns: 1, activeJobId: null },
        { name: "task-1", threadId: "thr_current", kind: "task", sandbox: "read-only", model: null, createdAt: "2026-03-24T20:00:00.000Z", updatedAt: "2026-03-24T20:00:00.000Z", createdBySession: "sess-current", lastPrompt: "Investigate the flaky test", lastJobId: "task-current", turns: 1, activeJobId: null }
      ]
    }, null, 2)}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.name, "task-2");
  assert.equal(payload.candidate.threadId, "thr_other");
  assert.equal(payload.candidate.lastPrompt, "Old rescue run");
  assert.match(payload.candidate.ageLabel, /ago$/);
});
```

Then append these new tests:

```js
function seedRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, env: buildEnv(binDir), statePath: path.join(binDir, "fake-codex-state.json") };
}

function readRegistry(repo) {
  return JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "threads.json"), "utf8"));
}

test("task registers a named persistent thread and prints the thread block", () => {
  const { repo, env, statePath } = seedRepo();
  const result = run("node", [SCRIPT, "task", "--name", "auth", "--write", "fix the auth bug"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
  assert.match(result.stdout, /Thread: auth \(thr_1\)\nFollow up: \/cx:ask auth <question>\nResume in Codex: codex resume thr_1/);

  const registry = readRegistry(repo);
  assert.equal(registry.threads.length, 1);
  assert.equal(registry.threads[0].name, "auth");
  assert.equal(registry.threads[0].threadId, "thr_1");
  assert.equal(registry.threads[0].kind, "task");
  assert.equal(registry.threads[0].sandbox, "workspace-write");
  assert.equal(registry.threads[0].turns, 1);
  assert.equal(registry.threads[0].activeJobId, null);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const thread = fakeState.threads.find((t) => t.id === "thr_1");
  assert.equal(thread.ephemeral, false);
  assert.equal(thread.name, "cx:auth");
});

test("task without --name auto-names the thread", () => {
  const { repo, env } = seedRepo();
  run("node", [SCRIPT, "task", "first"], { cwd: repo, env });
  const result = run("node", [SCRIPT, "task", "second"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readRegistry(repo).threads.map((t) => t.name), ["task-2", "task-1"]);
});

test("task --thread resumes the named thread with its own sandbox and model", () => {
  const { repo, env, statePath } = seedRepo();
  const start = run("node", [SCRIPT, "task", "--name", "auth", "--model", "gpt-5.4-mini", "look at auth"], { cwd: repo, env });
  assert.equal(start.status, 0, start.stderr);

  const follow = run("node", [SCRIPT, "task", "--thread", "auth", "follow up on that"], { cwd: repo, env });
  assert.equal(follow.status, 0, follow.stderr);
  assert.match(follow.stdout, /Resumed the prior run\./);
  assert.match(follow.stdout, /Thread: auth \(thr_1\)/);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.4-mini");
  assert.equal(fakeState.lastResume.sandbox, "read-only");
  assert.equal(readRegistry(repo).threads[0].turns, 2);
});

test("task --thread --write widens a read-only thread for that turn", () => {
  const { repo, env, statePath } = seedRepo();
  run("node", [SCRIPT, "task", "--name", "auth", "look"], { cwd: repo, env });
  const follow = run("node", [SCRIPT, "task", "--thread", "auth", "--write", "follow up and fix it"], { cwd: repo, env });
  assert.equal(follow.status, 0, follow.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastResume.sandbox, "workspace-write");
});

test("task --thread on an unknown name lists the known names", () => {
  const { repo, env } = seedRepo();
  run("node", [SCRIPT, "task", "--name", "auth", "look"], { cwd: repo, env });
  const result = run("node", [SCRIPT, "task", "--thread", "nope", "hi"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No thread named "nope"\. Known threads: auth\. Run \/cx:threads\./);
});

test("task flag combinations that conflict are rejected", () => {
  const { repo, env } = seedRepo();
  for (const args of [
    ["--name", "a", "--thread", "b", "x"],
    ["--thread", "b", "--fresh", "x"],
    ["--thread", "b", "--resume-last", "x"],
    ["--name", "a", "--resume-last", "x"],
    ["--name", "a", "--ephemeral", "x"]
  ]) {
    const result = run("node", [SCRIPT, "task", ...args], { cwd: repo, env });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /Choose either|cannot be combined/);
  }
});

test("task --ephemeral registers nothing and keeps upstream output", () => {
  const { repo, env, statePath } = seedRepo();
  const result = run("node", [SCRIPT, "task", "--ephemeral", "throwaway"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
  assert.equal(fs.existsSync(path.join(resolveStateDir(repo), "threads.json")), false);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.threads.find((t) => t.id === "thr_1").ephemeral, true);
});

test("a failed first run drops its registry entry", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  const result = run("node", [SCRIPT, "task", "--name", "doomed", "x"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 1);
  assert.deepEqual(readRegistry(repo).threads, []);
});

test("background task --thread goes through the worker and releases the lock", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  const env = buildEnv(binDir);
  const start = run("node", [SCRIPT, "task", "--name", "bg", "start"], { cwd: repo, env });
  assert.equal(start.status, 0, start.stderr);

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "--thread", "bg", "follow up"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");

  const busyAttempt = run("node", [SCRIPT, "task", "--thread", "bg", "again"], { cwd: repo, env });
  assert.equal(busyAttempt.status, 1);
  assert.match(busyAttempt.stderr, new RegExp(`Thread "bg" is busy with job ${launchPayload.jobId}`));

  const waited = run("node", [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"], { cwd: repo, env });
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");
  assert.equal(JSON.parse(waited.stdout).job.threadName, "bg");

  const registry = await waitFor(() => {
    const current = readRegistry(repo);
    return current.threads[0].activeJobId === null ? current : null;
  });
  assert.equal(registry.threads[0].turns, 2);
});

test("cancel releases the thread lock", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "--name", "slow", "take a while"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  await waitFor(() => {
    const status = run("node", [SCRIPT, "status", jobId, "--json"], { cwd: repo, env });
    return JSON.parse(status.stdout).job.status === "running" ? true : null;
  });

  const cancelled = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(readRegistry(repo).threads[0].activeJobId, null);
});
```

The fixture records `lastTurnStart` but not the resume request. Add `lastResume` to the fixture: in `tests/fake-codex-fixture.mjs`, inside `case "thread/resume":` after `thread.updatedAt = now();` add:

```js
        state.lastResume = { threadId: message.params.threadId, sandbox: message.params.sandbox ?? null, model: message.params.model ?? null };
```

(The fixture file is a template string, so this line is inside the backtick-quoted source. Keep the indentation style of the surrounding lines.)

- [ ] **Step 2: Run to verify the new and rewritten tests fail**

Run: `node --test tests/runtime.test.mjs 2>&1 | grep -E '^✖|^ℹ fail'`
Expected: the rewritten and new tests fail (unknown flags are treated as prompt text, no `threads.json` is written, `candidate.name` is undefined).

- [ ] **Step 3: Implement in `codex-companion.mjs`**

Add imports:

```js
import { buildRegisteredThreadName } from "./lib/codex.mjs";   // add to the existing import list from ./lib/codex.mjs
import {
  acquireThread,
  findLatestThread,
  forgetThread,
  listThreads,
  releaseThread,
  reserveThread,
  resolveThread
} from "./lib/threads.mjs";
import { appendThreadBlock, formatRelativeTime, renderThreadsReport } from "./lib/render.mjs";   // add to the existing render import
```

Delete `findLatestResumableTaskJob` and `resolveLatestTrackedTaskThread` (they are replaced below). Keep `filterJobsForCurrentClaudeSession` and `getCurrentClaudeSessionId`.

Replace `executeTaskRun` with:

```js
function threadSummary(entry) {
  return entry ? { name: entry.name, threadId: entry.threadId ?? null } : null;
}

async function resolveTaskThread(workspaceRoot, request) {
  if (request.threadRef) {
    const entry = resolveThread(workspaceRoot, request.threadRef);
    return { entry: acquireThread(workspaceRoot, entry.name, request.jobId), resumeThreadId: null };
  }
  if (request.resumeLast) {
    const latest = findLatestThread(workspaceRoot, { kind: "task", includeBusy: true });
    if (latest) {
      return { entry: acquireThread(workspaceRoot, latest.name, request.jobId), resumeThreadId: null };
    }
    const fallback = await findLatestTaskThread(workspaceRoot);
    if (!fallback) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    return { entry: null, resumeThreadId: fallback.id };
  }
  return { entry: null, resumeThreadId: null };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: Boolean(request.resumeLast || request.threadRef)
  });
  const prompt = request.prompt?.trim() || "";

  let { entry, resumeThreadId } = await resolveTaskThread(workspaceRoot, request);
  let sandbox = request.write ? "workspace-write" : "read-only";
  let model = request.model ?? null;

  if (entry) {
    resumeThreadId = entry.threadId;
    if (!request.write) {
      sandbox = entry.sandbox;
    }
    if (!model) {
      model = entry.model;
    }
  } else if (!resumeThreadId && !request.ephemeral) {
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

  if (!prompt && !resumeThreadId) {
    if (entry) {
      releaseThread(workspaceRoot, request.jobId, { dropIfUnstarted: true });
    }
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  let result;
  try {
    result = await runAppServerTurn(workspaceRoot, {
      resumeThreadId,
      prompt,
      defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
      model,
      effort: request.effort,
      sandbox,
      onProgress: request.onProgress,
      persistThread: Boolean(entry),
      threadName: entry && !resumeThreadId ? buildRegisteredThreadName(entry.name) : null
    });
  } catch (error) {
    if (entry) {
      releaseThread(workspaceRoot, request.jobId, { dropIfUnstarted: true });
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
    if (request.jobId) {
      upsertJob(workspaceRoot, { id: request.jobId, threadName: entry.name });
    }
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
```

Note `runAppServerTurn` already resumes with `ephemeral: false`, and when `persistThread` is false it starts an ephemeral thread exactly as upstream did, so `--ephemeral` and the `findLatestTaskThread` fallback keep upstream behaviour.

Replace `buildTaskRequest` with:

```js
function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, threadName = null, threadRef = null, ephemeral = false }) {
  return { cwd, model, effort, prompt, write, resumeLast, jobId, threadName, threadRef, ephemeral };
}
```

Replace `buildTaskRunMetadata`'s title line so a resumed run says `Codex Resume` and a fresh one `Codex Task` (unchanged), and add a `threadLabel` only through `upsertJob` above; no other change there.

Replace `handleTask` with:

```js
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
    if (threadRef) {
      resolveThread(workspaceRoot, threadRef);
    }
    const { payload } = enqueueBackgroundTask(cwd, job, request);
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
```

Delete the old `buildTaskJob` if nothing else uses it (check with grep; `handleTaskWorker` does not).

Replace `handleTaskResumeCandidate` with:

```js
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
```

In `handleCancel`, after the `upsertJob(workspaceRoot, { id: job.id, status: "cancelled", ... })` call, add:

```js
  releaseThread(workspaceRoot, job.id);
```

- [ ] **Step 4: Run the full runtime suite**

Run: `node --test tests/runtime.test.mjs 2>&1 | grep -E '^✖|^ℹ (pass|fail)'`
Expected: `fail 0`. Watch for upstream tests that compared exact task stdout (for example `write task output focuses on the Codex result without generic follow-up hints`, and `task --resume acts like --resume-last ...`): they now see the thread block appended. Update their `assert.equal(result.stdout, ...)` to `assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/)` style prefix checks, or add `--ephemeral` to their invocations when the test is about upstream's ephemeral behaviour. Do not weaken what they assert about Codex's own text.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/codex-companion.mjs tests/runtime.test.mjs tests/fake-codex-fixture.mjs
git commit -m "Register, resume and lock task threads through the registry"
```

---

### Task 7: Reviews register threads

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs` (`executeReviewRun`, `handleReviewCommand`)
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: `NATIVE_REVIEW_REGISTERS` and `NATIVE_REVIEW_FOLLOW_UP` from the Task 1 spike file.
- Produces: review payloads carry `thread: { name, threadId }`; `review --name <thread>` and `adversarial-review --name <thread>` flags; the constants `NATIVE_REVIEW_REGISTERS` and `NATIVE_REVIEW_FOLLOW_UP` in `codex-companion.mjs`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/runtime.test.mjs`:

```js
function seedDirtyRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");
  return { repo, binDir, env: buildEnv(binDir), statePath: path.join(binDir, "fake-codex-state.json") };
}

test("review registers a persistent named thread", () => {
  const { repo, env, statePath } = seedDirtyRepo();
  const result = run("node", [SCRIPT, "review", "--name", "pr-review"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No material issues found/);
  assert.match(result.stdout, /Thread: pr-review \(thr_1\)\nFollow up: \/cx:ask pr-review <question>/);

  const registry = readRegistry(repo);
  assert.equal(registry.threads[0].name, "pr-review");
  assert.equal(registry.threads[0].kind, "review");
  assert.equal(registry.threads[0].sandbox, "read-only");
  assert.equal(registry.threads[0].threadId, "thr_1");
  assert.equal(registry.threads[0].turns, 1);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.threads.find((t) => t.id === "thr_1").ephemeral, false);
  assert.equal(fakeState.threads.find((t) => t.id === "thr_1").name, "cx:pr-review");
});

test("review auto-names its thread review-N", () => {
  const { repo, env } = seedDirtyRepo();
  run("node", [SCRIPT, "review"], { cwd: repo, env });
  const second = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readRegistry(repo).threads.map((t) => t.name), ["review-2", "review-1"]);
});

test("adversarial review registers an adv-N thread that task --thread can continue", () => {
  const { repo, env, statePath } = seedDirtyRepo();
  const review = run("node", [SCRIPT, "adversarial-review", "challenge the design"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /Thread: adv-1 \(thr_1\)/);
  assert.equal(readRegistry(repo).threads[0].kind, "adversarial-review");

  const follow = run("node", [SCRIPT, "task", "--thread", "adv-1", "follow up on finding 1"], { cwd: repo, env });
  assert.equal(follow.status, 0, follow.stderr);
  assert.match(follow.stdout, /Resumed the prior run/);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastResume.sandbox, "read-only");
});

test("review --name rejects a duplicate name before contacting Codex", () => {
  const { repo, env } = seedDirtyRepo();
  run("node", [SCRIPT, "review", "--name", "dup"], { cwd: repo, env });
  const again = run("node", [SCRIPT, "review", "--name", "dup"], { cwd: repo, env });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /A thread named "dup" already exists/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/runtime.test.mjs --test-name-pattern "review (registers|auto-names|--name)|adversarial review registers"`
Expected: FAIL, `--name` is treated as focus text (native review rejects it) and no registry is written.

- [ ] **Step 3: Implement**

Near the top of `codex-companion.mjs`, after `STOP_REVIEW_TASK_MARKER`, add the spike constants with the values from `docs/superpowers/spikes/2026-10-08-native-review-follow-up.md`:

```js
// Set by the spike recorded in docs/superpowers/spikes/2026-10-08-native-review-follow-up.md.
const NATIVE_REVIEW_REGISTERS = "sourceThreadId";
const NATIVE_REVIEW_FOLLOW_UP = true;
```

In `executeReviewRun`, after `const reviewName = request.reviewName ?? "Review";` add:

```js
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  const kind = reviewName === "Review" ? "review" : "adversarial-review";
  const entry = request.ephemeral
    ? null
    : reserveThread(workspaceRoot, {
        name: request.threadName,
        kind,
        sandbox: "read-only",
        model: request.model ?? null,
        sessionId: getCurrentClaudeSessionId(),
        jobId: request.jobId,
        prompt: `${reviewName} ${target.label}${focusText ? `: ${focusText}` : ""}`
      });
  const codexThreadName = entry ? buildRegisteredThreadName(entry.name) : null;

  const finish = (result, registeredThreadId) => {
    if (!entry) {
      return null;
    }
    const [released] = releaseThread(workspaceRoot, request.jobId, {
      threadId: registeredThreadId,
      lastPrompt: entry.lastPrompt,
      lastJobId: request.jobId,
      turnCompleted: result.status === 0
    });
    if (request.jobId) {
      upsertJob(workspaceRoot, { id: request.jobId, threadName: released.name });
    }
    return threadSummary(released);
  };
```

Wrap both runner calls so failures drop the entry. For the native branch:

```js
    let result;
    try {
      result = await runAppServerReview(request.cwd, {
        target: reviewTarget,
        model: request.model,
        onProgress: request.onProgress,
        persistThread: Boolean(entry),
        threadName: codexThreadName
      });
    } catch (error) {
      if (entry) {
        releaseThread(workspaceRoot, request.jobId, { dropIfUnstarted: true });
      }
      throw error;
    }
    const thread = finish(result, result[NATIVE_REVIEW_REGISTERS]);
```

Then add `thread` to the native `payload`, and wrap `rendered` with `appendThreadBlock(renderNativeReviewResult(...), thread)`. Add `threadId: result[NATIVE_REVIEW_REGISTERS]` in the returned object so `status` and `result` show the thread that can be resumed.

For the adversarial branch, the same pattern around `runAppServerTurn`, passing `persistThread: Boolean(entry), threadName: codexThreadName`, then `const thread = finish(result, result.threadId);`, `thread` in the payload, and `rendered: appendThreadBlock(renderReviewResult(parsed, {...}), thread)`.

Move the `const target = resolveReviewTarget(...)` and `focusText` lines above the new block if they are not already (they are, in upstream).

In `handleReviewCommand`, add `"name"` to `valueOptions`, and pass `threadName: options.name ?? null, jobId: job.id` in the `executeReviewRun({...})` call. Also, before creating the job, validate the name early so a duplicate fails before any Codex call:

```js
  if (options.name) {
    validateThreadName(options.name);
  }
```

(import `validateThreadName` from `./lib/threads.mjs`). The duplicate check itself happens inside `reserveThread`, which runs before the app server is contacted.

- [ ] **Step 4: Run the full runtime suite**

Run: `node --test tests/runtime.test.mjs 2>&1 | grep -E '^✖|^ℹ (pass|fail)'`
Expected: `fail 0`. Upstream review tests that compared exact stdout now see the thread block; adjust them to prefix matches as in Task 6 Step 4.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/codex-companion.mjs tests/runtime.test.mjs
git commit -m "Register review and adversarial-review threads"
```

---

### Task 8: `ask`, `threads` and `forget` subcommands

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs` (`printUsage`, `main`, new handlers)
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: `launchTask` from Task 6, `listThreads`, `forgetThread`, `resolveThread`, `renderThreadsReport`, `NATIVE_REVIEW_FOLLOW_UP`.
- Produces: subcommands `ask <ref> [--background|--wait] [--write] [--model] [--effort] [--json] [prompt]`, `threads [--json]`, `forget <name> [--json]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/runtime.test.mjs`:

```js
test("ask resumes a named thread and is read-only by default", () => {
  const { repo, env, statePath } = seedDirtyRepo();
  run("node", [SCRIPT, "review", "--name", "rev"], { cwd: repo, env });
  const result = run("node", [SCRIPT, "ask", "rev", "elaborate on the follow up"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Resumed the prior run\./);
  assert.match(result.stdout, /Thread: rev \(thr_1\)/);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "elaborate on the follow up");
  assert.equal(fakeState.lastResume.sandbox, "read-only");
});

test("ask requires a thread and a prompt", () => {
  const { repo, env } = seedRepo();
  const noThread = run("node", [SCRIPT, "ask"], { cwd: repo, env });
  assert.equal(noThread.status, 1);
  assert.match(noThread.stderr, /Usage: ask <thread> <prompt>/);

  run("node", [SCRIPT, "task", "--name", "t", "x"], { cwd: repo, env });
  const noPrompt = run("node", [SCRIPT, "ask", "t"], { cwd: repo, env });
  assert.equal(noPrompt.status, 1);
  assert.match(noPrompt.stderr, /Provide a question for thread "t"/);
});

test("ask on an unknown thread fails before anything is queued", () => {
  const { repo, env } = seedRepo();
  const result = run("node", [SCRIPT, "ask", "ghost", "--background", "hi"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No thread named "ghost"/);
  const status = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env });
  assert.deepEqual(JSON.parse(status.stdout).running, []);
});

test("ask --background queues a job that carries the thread name", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  const env = buildEnv(binDir);
  run("node", [SCRIPT, "task", "--name", "bg", "start"], { cwd: repo, env });
  const launched = run("node", [SCRIPT, "ask", "bg", "--background", "--json", "follow up"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"], { cwd: repo, env });
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");
  assert.equal(JSON.parse(waited.stdout).job.threadName, "bg");
  assert.equal(JSON.parse(waited.stdout).job.title, "Codex Ask bg");
});

test("threads lists registered threads and forget removes one", () => {
  const { repo, env } = seedDirtyRepo();
  const empty = run("node", [SCRIPT, "threads"], { cwd: repo, env });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No Codex threads in this repository\./);

  run("node", [SCRIPT, "review", "--name", "rev"], { cwd: repo, env });
  run("node", [SCRIPT, "task", "--name", "fix", "--write", "fix it"], { cwd: repo, env });

  const listed = run("node", [SCRIPT, "threads"], { cwd: repo, env });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /\| fix \| task \| idle \| 1 \| just now \| fix it \|/);
  assert.match(listed.stdout, /\| rev \| review \| idle \| 1 \| just now \| Review working tree diff \|/);

  const asJson = run("node", [SCRIPT, "threads", "--json"], { cwd: repo, env });
  assert.deepEqual(JSON.parse(asJson.stdout).threads.map((t) => t.name), ["fix", "rev"]);

  const forgotten = run("node", [SCRIPT, "forget", "rev"], { cwd: repo, env });
  assert.equal(forgotten.status, 0, forgotten.stderr);
  assert.match(forgotten.stdout, /Forgot thread rev\.\nThe Codex conversation itself is untouched\.\nResume in Codex: codex resume thr_1/);
  assert.deepEqual(readRegistry(repo).threads.map((t) => t.name), ["fix"]);

  const missing = run("node", [SCRIPT, "forget", "rev"], { cwd: repo, env });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No thread named "rev"/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/runtime.test.mjs --test-name-pattern "^ask|^threads"`
Expected: FAIL with `Unknown subcommand: ask` and `Unknown subcommand: threads`.

- [ ] **Step 3: Implement**

Add the handlers to `codex-companion.mjs`:

```js
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
      `Note: built-in reviews cannot see their own findings on follow-up. For a reviewer you can question, use /cx:adversarial-review --name <name>.\n`
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
```

Add to `main()`'s switch:

```js
    case "ask":
      await handleAsk(argv);
      break;
    case "threads":
      handleThreads(argv);
      break;
    case "forget":
      handleForget(argv);
      break;
```

Update `printUsage` to list:

```
  node scripts/codex-companion.mjs review [--wait|--background] [--name <thread>] [--base <ref>] [--scope <auto|working-tree|branch>]
  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--name <thread>] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]
  node scripts/codex-companion.mjs task [--background] [--write] [--name <thread>|--thread <ref>|--resume-last|--resume|--fresh] [--ephemeral] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]
  node scripts/codex-companion.mjs ask <thread> [--background|--wait] [--write] [--model <model|spark>] [--effort <effort>] [prompt]
  node scripts/codex-companion.mjs threads [--json]
  node scripts/codex-companion.mjs forget <thread> [--json]
```

keeping the other existing lines.

- [ ] **Step 4: Run the full runtime suite**

Run: `node --test tests/runtime.test.mjs 2>&1 | grep -E '^✖|^ℹ (pass|fail)'`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/codex-companion.mjs tests/runtime.test.mjs
git commit -m "Add ask, threads and forget subcommands"
```

---

### Task 9: Stop-gate review runs stay ephemeral

**Files:**
- Modify: `plugins/codex/scripts/stop-review-gate-hook.mjs` (function `runStopReview`, near line 105)
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: `task --ephemeral` from Task 6.

- [ ] **Step 1: Write the failing test**

Find the existing stop-gate test in `tests/runtime.test.mjs` (search for `STOP_HOOK`) and copy its setup for a repo with the review gate enabled. Append:

```js
test("the stop-time review gate never registers a thread", () => {
  const { repo, env } = seedDirtyRepo();
  const enable = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(enable.status, 0, enable.stderr);

  const hook = run("node", [STOP_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-gate",
      last_assistant_message: "I changed src/app.js to bump the value."
    })
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(JSON.parse(hook.stdout).decision, "block");
  assert.equal(fs.existsSync(path.join(resolveStateDir(repo), "threads.json")), false);
});
```

The `decision: "block"` assertion proves the gate really ran a Codex task (the default fixture behaviour reports a finding); the last line is the one this task is about. The input shape matches the existing test `stop hook blocks when the review finds issues` near line 1950.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/runtime.test.mjs --test-name-pattern "never registers"`
Expected: FAIL, `threads.json` exists.

- [ ] **Step 3: Implement**

In `stop-review-gate-hook.mjs` change the spawn arguments from
`[scriptPath, "task", "--json", prompt]` to `[scriptPath, "task", "--json", "--ephemeral", prompt]`.

- [ ] **Step 4: Run the test**

Run: `node --test tests/runtime.test.mjs --test-name-pattern "stop|never registers"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/stop-review-gate-hook.mjs tests/runtime.test.mjs
git commit -m "Keep stop-gate review runs off the thread registry"
```

---

### Task 10: Slash commands, rescue agent, runtime skill, follow-up skill

**Files:**
- Create: `plugins/codex/commands/ask.md`, `plugins/codex/commands/threads.md`, `plugins/codex/commands/forget.md`, `plugins/codex/skills/cx-follow-up/SKILL.md`
- Modify: `plugins/codex/commands/review.md`, `adversarial-review.md`, `rescue.md`, `status.md`, `result.md`, `plugins/codex/agents/codex-rescue.md`, `plugins/codex/skills/codex-cli-runtime/SKILL.md`
- Test: `tests/commands.test.mjs`

**Interfaces:**
- Consumes: the subcommands from Tasks 6 to 8.

- [ ] **Step 1: Write the failing tests**

Append to `tests/commands.test.mjs`:

```js
test("ask command forwards to the ask subcommand verbatim and never fixes code", () => {
  const source = read("commands/ask.md");
  assert.match(source, /argument-hint: '<thread> \[--wait\|--background\] \[--write\] <question>'/);
  assert.match(source, /disable-model-invocation: true/);
  assert.match(source, /codex-companion\.mjs" ask "\$ARGUMENTS"/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /Return the command stdout verbatim/i);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /\/cx:threads/);
});

test("threads and forget commands are inline bang commands", () => {
  const threads = read("commands/threads.md");
  assert.match(threads, /!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" threads "\$ARGUMENTS"`/);
  assert.match(threads, /disable-model-invocation: true/);
  const forget = read("commands/forget.md");
  assert.match(forget, /!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" forget "\$ARGUMENTS"`/);
  assert.match(forget, /argument-hint: '<thread>'/);
});

test("review commands document --name and the follow-up hint", () => {
  for (const file of ["commands/review.md", "commands/adversarial-review.md"]) {
    const source = read(file);
    assert.match(source, /\[--name <thread>\]/, file);
    assert.match(source, /\/cx:ask/, file);
  }
});

test("rescue command asks about the named candidate thread and forwards --thread", () => {
  const source = read("commands/rescue.md");
  assert.match(source, /task-resume-candidate --json/);
  assert.match(source, /candidate\.name/);
  assert.match(source, /ageLabel/);
  assert.match(source, /--thread <ref>/);
  assert.match(source, /--name <thread>/);
});

test("rescue agent and runtime skill pass --name and --thread through to task", () => {
  const agent = read("agents/codex-rescue.md");
  assert.match(agent, /--thread/);
  assert.match(agent, /--name/);
  assert.match(agent, /`--resume` means add `--resume-last`/);
  const runtime = read("skills/codex-cli-runtime/SKILL.md");
  assert.match(runtime, /task --thread <ref>/);
  assert.match(runtime, /task --name <thread>/);
});

test("follow-up skill maps natural language to ask", () => {
  const source = read("skills/cx-follow-up/SKILL.md");
  assert.match(source, /^name: cx-follow-up$/m);
  assert.match(source, /ask that reviewer/i);
  assert.match(source, /threads --json/);
  assert.match(source, /codex-companion\.mjs" ask/);
  assert.match(source, /verbatim/i);
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /Never answer on Codex's behalf/i);
  assert.doesNotMatch(source, /user-invocable: false/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/commands.test.mjs`
Expected: the six new tests FAIL (files missing or text absent).

- [ ] **Step 3: Create the new command files**

`plugins/codex/commands/ask.md`:

````markdown
---
description: Send a follow-up question or instruction to a named Codex thread
argument-hint: '<thread> [--wait|--background] [--write] <question>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Continue an existing Codex thread by name. The thread keeps its full history, so the question can refer to what Codex said before.

Raw slash-command arguments:
`$ARGUMENTS`

Rules:
- The first token is the thread name. Run `/cx:threads` if the user does not know it.
- Preserve the user's question exactly. Do not rewrite it.
- `--wait` and `--background` are Claude-side execution flags. If neither is given, run in the foreground.
- `--write` lets Codex edit files on this turn even if the thread started read-only. Pass it through only when the user asked for changes.
- This command is a relay. Do not fix issues, apply patches, or answer in Codex's place.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ask "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.

Background flow (when `--background` is present):
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ask "$ARGUMENTS"`,
  description: "Codex follow-up",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- Tell the user: "Codex follow-up started in the background. Check `/cx:status` for progress and `/cx:result` for the answer."

If the command fails because the thread is busy, show the error and suggest `/cx:status <job-id>` or `/cx:cancel <job-id>`.
````

`plugins/codex/commands/threads.md`:

```markdown
---
description: List the named Codex threads in this repository
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" threads "$ARGUMENTS"`

Present the table exactly as returned. Do not summarize it. Remind the user that `/cx:ask <thread> <question>` continues any idle thread.
```

`plugins/codex/commands/forget.md`:

```markdown
---
description: Drop a named Codex thread from this repository's registry (the Codex conversation itself is kept)
argument-hint: '<thread>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" forget "$ARGUMENTS"`

Present the output exactly as returned, including the `codex resume` command.
```

- [ ] **Step 4: Update the existing command files**

`review.md` and `adversarial-review.md`:
- Change `argument-hint` to include `[--name <thread>]` after the `--wait|--background` group.
- Under "Argument handling" add: `- `--name <thread>` names the Codex thread so the user can continue it later with `/cx:ask <thread> <question>`. Pass it through unchanged. Without it the plugin picks `review-N` (or `adv-N`).`
- Under "Foreground flow", after "Return the command stdout verbatim", add: `- The output ends with a `Thread:` line and a `Follow up:` hint. Leave them in place; they are how the user continues the review.`

`rescue.md`:
- `argument-hint` becomes `"[--background|--wait] [--resume|--fresh|--thread <ref>|--name <thread>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should investigate, solve, or continue]"`.
- In "Execution mode", add before the candidate check: `- If the request includes `--thread <ref>` or `--name <thread>`, do not ask whether to continue. Forward them unchanged.`
- Replace the candidate question wording with: when the helper reports `available: true`, the first option label is `Continue thread <candidate.name> (<candidate.ageLabel>: "<candidate.lastPrompt>")` and the second is `Start a new Codex thread`. Keep the recommended-first rule.
- In "Operating rules" add: `- Leave `--thread` and `--name` in the forwarded request. The subagent maps them to `task --thread` and `task --name`.`

`status.md`: add `- Each job may carry a `Thread` name; keep it in the table so the user can `/cx:ask` it.`

`result.md`: add `- Thread name and the `Follow up:` line` to the list of details to preserve.

`agents/codex-rescue.md`, in "Forwarding rules" after the `--fresh` line, add:

```
- `--thread <ref>` means add `--thread <ref>` to the `task` call and strip it from the task text.
- `--name <thread>` means add `--name <thread>` to the `task` call and strip it from the task text.
- If the user names a thread in words ("the auth thread", "that reviewer"), do not guess. Forward without `--thread`; the main thread resolves names through the `cx-follow-up` skill.
```

`skills/codex-cli-runtime/SKILL.md`, in "Command selection" add:

```
- If the forwarded request includes `--thread <ref>`, pass `task --thread <ref>` and strip the token from the task text.
- If the forwarded request includes `--name <thread>`, pass `task --name <thread>` and strip the token from the task text.
- `--thread` and `--resume-last` are mutually exclusive; `--thread` wins when both are present.
```

- [ ] **Step 5: Create the follow-up skill**

`plugins/codex/skills/cx-follow-up/SKILL.md`:

````markdown
---
name: cx-follow-up
description: Use when the user wants to continue, question, or steer an earlier Codex run -- "ask that reviewer to elaborate", "tell codex to apply fix 2", "what did codex mean by X", "have the codex thread dig deeper", "continue the codex review". Resolves which named Codex thread they mean and sends the follow-up through the cx plugin.
---

# Codex follow-up

The cx plugin keeps every Codex run as a named thread per repository. A follow-up is a new turn on one of those threads, so Codex answers with its full earlier context.

Steps:

1. List the threads:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" threads --json
```

2. Pick the thread:
- If the user named one (`review-2`, `auth`, "the adv thread"), use that name.
- Else if they said "reviewer", "review", or "the review", take the most recently updated thread whose `kind` is `review` or `adversarial-review`.
- Else if they said "task", "rescue", "the fix", take the most recently updated thread with `kind` `task`.
- Else take the most recently updated thread.
- If two threads are equally plausible (same kind, updated within a few minutes of each other), use `AskUserQuestion` once, listing each candidate as `<name> (<kind>, <lastPrompt>)`.
- If the registry is empty, say there is no Codex thread to continue and suggest `/cx:review`, `/cx:adversarial-review`, or `/cx:rescue`.

3. Send the follow-up, quoting the user's words verbatim as the prompt:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ask <name> "<the user's question>"
```
Add `--write` only when the user asked Codex to change files. Add `--background` and use `run_in_background: true` when the question clearly needs a long investigation.

4. Return the command's stdout verbatim. Never answer on Codex's behalf, never summarize, never fix the code yourself.

If the thread is busy, the command says which job holds it. Show that and suggest `/cx:status <job-id>` or `/cx:cancel <job-id>`.
````

- [ ] **Step 6: Run the command tests and the full suite**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)|^✖ '`
Expected: `fail 1`, only the known upstream failure.

- [ ] **Step 7: Commit**

```bash
git add plugins/codex/commands plugins/codex/agents plugins/codex/skills tests/commands.test.mjs
git commit -m "Expose named threads through slash commands, the rescue agent and a follow-up skill"
```

---

### Task 11: README, changelog, version bump, final verification

**Files:**
- Modify: `README.md`, `plugins/codex/CHANGELOG.md`, `package.json`, `package-lock.json`, `plugins/codex/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Test: `tests/bump-version.test.mjs` (existing), `npm run check-version`

- [ ] **Step 1: Bump the version**

Run: `node scripts/bump-version.mjs 1.1.0 && npm run check-version`
Expected: all four files report 1.1.0 and the check passes. If the script refuses, edit the six `1.0.6` occurrences listed by `grep -n '1\.0\.6' package.json package-lock.json plugins/codex/.claude-plugin/plugin.json .claude-plugin/marketplace.json` by hand.

- [ ] **Step 2: Changelog**

Prepend to `plugins/codex/CHANGELOG.md`:

```markdown
## 1.1.0

- Renamed the plugin and command prefix to `cx` so it installs beside the upstream `codex` plugin.
- Every review, adversarial review and rescue now runs on a persistent Codex thread recorded by name per repository (`review-N`, `adv-N`, `task-N`, or `--name <thread>`).
- New `/cx:ask <thread> <question>` continues any thread with its full history; `/cx:threads` lists them; `/cx:forget <thread>` drops one from the registry.
- `/cx:rescue --resume` and the resume prompt now name the thread and its age, and work across Claude sessions.
- New `cx-follow-up` skill lets "ask that reviewer to elaborate" route to the right thread.
- Stop-gate reviews run ephemeral and are never registered.
```

- [ ] **Step 3: README**

Rewrite `README.md` with these sections, keeping upstream's install prerequisites and FAQ text where still true:

1. Title `# cx: Codex threads for Claude Code`, one paragraph: a fork of `openai/codex-plugin-cc` whose Codex runs are named, persistent threads you can question later.
2. Install (the block from Task 2).
3. "Threads" section: how names are chosen, that threads live per repository and survive Claude sessions, the `Thread:` / `Follow up:` footer, one worked example:

```
/cx:review --name pr-412 --base main
...findings...
/cx:ask pr-412 elaborate on the race you flagged in the cache layer
/cx:threads
```

4. Command reference: every `/cx:` command with its flags, including `--name` on reviews and rescue, `--thread` on rescue, and `ask`, `threads`, `forget`.
5. "Native review follow-ups" paragraph stating the spike result from `docs/superpowers/spikes/2026-10-08-native-review-follow-up.md` in one or two sentences, and when to prefer `/cx:adversarial-review --name`.
6. "Merging upstream":

```bash
git fetch upstream
git merge upstream/main
# expect conflicts in plugins/codex/commands/*.md and README.md from the /cx: rename;
# keep the cx side, then run: npm test
```

7. Upstream's "Codex Integration", "Common Configurations" and FAQ sections, with `/codex:` replaced by `/cx:` (already done by Task 2).

- [ ] **Step 4: Remove AI-style comment noise and run everything**

Review the diff for comments that narrate the obvious and delete them. The only comment this plan adds is the spike pointer above `NATIVE_REVIEW_REGISTERS`, which stays.

Run:

```bash
npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)|^✖ '
npm run build
grep -rn '/codex:\|codex:codex-rescue' plugins README.md ; echo "grep exit $?"
```

Expected: `fail 1` with only the known upstream failure; build succeeds (it needs `codex` installed, as CI does); the grep prints nothing and exits 1.

- [ ] **Step 5: Manual smoke test against the real Codex CLI**

From a repository with a small uncommitted change (the spike repo from Task 1 works), with the plugin installed from the local checkout (`/plugin marketplace add ~/Documents/src/codex-plugin-cc` then `/plugin install cx@cx`, `/reload-plugins`):

1. `/cx:review --name smoke --wait` -- output ends with `Thread: smoke (...)`.
2. `/cx:ask smoke what was your first finding?` -- Codex refers to the finding (or, if `NATIVE_REVIEW_FOLLOW_UP` is false, the one-line notice appears on stderr and Codex answers without context).
3. `/cx:adversarial-review --name smoke-adv --wait challenge the change` then `/cx:ask smoke-adv elaborate on finding 1` -- Codex quotes its finding.
4. `/cx:threads` -- both threads listed idle with turns 2.
5. Start a new Claude Code session in the same repo, `/cx:threads` -- both still listed.
6. "ask that reviewer to elaborate on the first finding" in plain words -- the follow-up skill runs `ask smoke-adv ...`.
7. `/cx:forget smoke` -- removed; `/cx:threads` shows one.

Record anything that misbehaves as a bug before the branch is considered done.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Document named threads and release 1.1.0"
```

---

## Self-review against the spec

- Spec 1 registry: Task 3. The spec's JSON omits `counters`; the spec is amended to include it.
- Spec 2 runtime: Task 4.
- Spec 3 runners: Tasks 6 and 7, cancel release in Task 6.
- Spec 4 CLI surface: Tasks 6 and 8; `task-resume-candidate` in Task 6.
- Spec 5 output: Task 5, wired in Tasks 6 and 7.
- Spec 6 commands, agent, skills, rename: Tasks 2 and 10. Stop gate `--ephemeral`: Task 9.
- Spec 7 spike: Task 1, consumed in Task 7 and Task 8's notice.
- Spec 8 tests: Tasks 3, 5, 6, 7, 8, 9, 10. The two upstream tests that change meaning are rewritten in Task 6. The session-end hook test (registry survives cleanup) is covered by `tests/threads.test.mjs` "the registry survives saveState", which is the function the hook calls.
- Spec 9 docs and version: Task 11.

## Implementation notes (2026-10-08)

Where the code differs from the steps above:

- Background launches (`task --background`, `ask --background`) reserve or
  lock the thread in the launching process, not in the worker, so a second
  command sees the thread as busy at once. The worker finds the thread already
  held by its own job id (`holdThreadForBackgroundJob`, `findThreadHeldByJob`).
- A run that fails or is cancelled after Codex created the thread keeps its
  registry entry. The runner remembers the first thread id reported through
  progress events (`trackStartedThread`, `releaseFailedThread`). Only a run
  that never got a thread id is dropped.
- `scripts/bump-version.mjs` and its test looked the plugin up by the name
  `codex` in the marketplace manifest; both now use `cx`.
- Upstream tests that compared exact task output use `assertTaskOutput`, which
  checks Codex's text and then the thread footer. Two command tests were
  updated for the new command files and the reworded rescue question.
- Task 11 step 5 was run through `codex-companion.mjs` directly against Codex
  CLI 0.161.0, not through installed slash commands. Review, ask, adversarial
  review, background ask, busy rejection, survival across a session-end hook,
  and forget all behaved as specified. Installing the plugin in Claude Code
  and trying the `cx-follow-up` skill in plain words is still to do.
