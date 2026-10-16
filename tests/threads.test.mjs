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
