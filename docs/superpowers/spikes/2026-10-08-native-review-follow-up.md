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
