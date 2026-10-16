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
