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
