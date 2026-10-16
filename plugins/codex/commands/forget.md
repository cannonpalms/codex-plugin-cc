---
description: Drop a named Codex thread from this repository's registry (the Codex conversation itself is kept)
argument-hint: '<thread>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" forget "$ARGUMENTS"`

Present the output exactly as returned, including the `codex resume` command.
