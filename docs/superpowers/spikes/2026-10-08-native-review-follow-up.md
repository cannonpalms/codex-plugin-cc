# Spike: native review follow-up

Date: 2026-10-08
Codex CLI: codex-cli 0.161.0

## Method

Started a non-ephemeral thread through `codex app-server`, ran `review/start`
with `delivery: "inline"` and target `uncommittedChanges` on a repository
whose only change turned `a + b` into `a - b`, then called `thread/resume`
and `turn/start` on the same thread asking Codex to quote its first finding
verbatim without reading files or running commands.

## Result

- Source thread follow-up: worked -- Codex quoted `[P1] Preserve addition in
  add ... math.js:2-2` word for word and elaborated on it.
- Review thread follow-up: not separate -- with inline delivery
  `reviewThreadId` equals the source thread id.

## Decision

NATIVE_REVIEW_REGISTERS = "sourceThreadId"
NATIVE_REVIEW_FOLLOW_UP = true

## Correction, later the same day

The result above was too narrow a test. Quoting a finding only needs the
review's final text. Asked "what did you check", the same thread answered
that it could not say. Its stored history holds a synthetic user message,
"Here's the full review output from reviewer model", and the write-up. The
reviewer's diffs, commands and reasoning are not in it.

Codex runs the built-in reviewer in a separate sub-agent session:

- It is written to disk beside the requesting thread, with
  `source: {"subAgent": "review"}` and `parent_thread_id` set to the
  requesting thread, and it holds the reviewer's tool calls and their output.
- No notification during `review/start` carries its id, and `reviewThreadId`
  in the response is the requesting thread.
- `thread/list` with `sourceKinds: ["subAgentReview"]` returns it with
  `parentThreadId`.
- `thread/resume` and `turn/start` work on it, and `thread/name/set` too.
  Told not to run anything and asked what it had run, it listed its shell
  commands and the files whose diffs it read.
- `delivery: "detached"` is not an alternative: the app server answers
  "paginated threads do not support detached review" for persistent and
  ephemeral source threads alike.

## Decision (supersedes the one above)

Register the reviewer's sub-agent session for built-in reviews, found through
`thread/list`. Fall back to the requesting thread when none is reported.
NATIVE_REVIEW_FOLLOW_UP = true
