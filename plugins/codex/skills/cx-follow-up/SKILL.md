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
