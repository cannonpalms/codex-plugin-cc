# Changelog

## 1.1.0

- Renamed the plugin and command prefix to `cx` so it installs beside the upstream `codex` plugin.
- Every review, adversarial review and rescue now runs on a persistent Codex thread recorded by name per repository (`review-N`, `adv-N`, `task-N`, or `--name <thread>`).
- New `/cx:ask <thread> <question>` continues any thread with its full history; `/cx:threads` lists them; `/cx:forget <thread>` drops one from the registry.
- `/cx:rescue --resume` and the resume prompt now name the thread and its age, and work across Claude sessions.
- New `cx-follow-up` skill lets "ask that reviewer to elaborate" route to the right thread.
- Stop-gate reviews run ephemeral and are never registered.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
