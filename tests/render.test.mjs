import test from "node:test";
import assert from "node:assert/strict";

import {
  appendThreadBlock,
  formatRelativeTime,
  renderJobStatusReport,
  renderReviewResult,
  renderStoredJobResult,
  renderThreadBlock,
  renderThreadsReport
} from "../plugins/codex/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

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
