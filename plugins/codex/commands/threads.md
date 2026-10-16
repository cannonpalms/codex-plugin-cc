---
description: List the named Codex threads in this repository
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" threads "$ARGUMENTS"`

Present the table exactly as returned. Do not summarize it. Remind the user that `/cx:ask <thread> <question>` continues any idle thread.
