# cx: Codex threads for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks, and keep talking to the same Codex conversation afterwards.

This is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). Every Codex run it starts is a named, persistent thread. You can come back to any of them later, by name, with a follow-up question or instruction, and Codex answers with its full earlier context. The plugin is named `cx` so it can be installed beside the upstream `codex` plugin.

## What You Get

- `/cx:review` for a normal read-only Codex review
- `/cx:adversarial-review` for a steerable challenge review
- `/cx:rescue` to delegate a task to Codex
- `/cx:ask` to send a follow-up to any earlier review or task, `/cx:threads` to list them, and `/cx:forget` to drop one
- `/cx:transfer`, `/cx:status`, `/cx:result`, and `/cx:cancel` to hand off sessions and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add cannonpalms/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install cx@cx
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/cx:setup
```

`/cx:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `cx:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/cx:review --background
/cx:status
/cx:result
```

## Threads

Every review, adversarial review and rescue runs on its own Codex thread. The plugin records each thread by name, per repository, so a thread started in one Claude Code session is still there in the next.

- Pass `--name <thread>` to choose the name. Names are lowercase letters, digits, `.`, `_` and `-`.
- Without `--name` the plugin picks `review-N`, `adv-N` or `task-N`.
- Each result ends with the thread name and a ready-made follow-up command:

```text
Thread: pr-412 (01a11c22-078d-7693-aeb0-4881b876131f)
Follow up: /cx:ask pr-412 <question>
Resume in Codex: codex resume 01a11c22-078d-7693-aeb0-4881b876131f
```

A typical exchange:

```bash
/cx:review --name pr-412 --base main
/cx:ask pr-412 elaborate on the race you flagged in the cache layer
/cx:threads
```

You can also say it in plain words. "Ask that reviewer to elaborate on the second finding" finds the most recent review thread and sends the question to it.

Several threads can run at once. A single thread takes one turn at a time, so `/cx:ask` on a thread that is still working reports the job that holds it.

Each follow-up re-sends the thread's history to Codex, so a very long-lived thread costs more per question. Start a fresh one when the topic changes.

## Usage

### `/cx:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait`, `--background` and `--name <thread>`. The review itself does not take custom focus text, but you can question it afterwards with [`/cx:ask`](#cxask). Use [`/cx:adversarial-review`](#cxadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/cx:review
/cx:review --base main
/cx:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/cx:status`](#cxstatus) to check on the progress and [`/cx:cancel`](#cxcancel) to cancel the ongoing task.

### `/cx:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/cx:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/cx:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/cx:adversarial-review
/cx:adversarial-review --base main challenge whether this was the right caching and retry design
/cx:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/cx:rescue`

Hands a task to Codex through the `cx:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, `--fresh`, `--name <thread>` and `--thread <ref>`. If you omit all of the thread flags, the plugin can offer to continue the latest rescue thread for this repo, naming it and saying how old it is. `--name` starts a new thread with that name. `--thread` continues a specific one.

Examples:

```bash
/cx:rescue investigate why the tests started failing
/cx:rescue fix the failing test with the smallest safe patch
/cx:rescue --resume apply the top fix from the last run
/cx:rescue --name auth-fix investigate the login redirect loop
/cx:rescue --thread auth-fix now write a regression test for it
/cx:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/cx:rescue --model spark fix the issue quickly
/cx:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo, including one from an earlier Claude Code session

### `/cx:ask`

Sends a follow-up question or instruction to a named thread.

```bash
/cx:ask review-2 what did you mean by the second finding?
/cx:ask adv-1 --background re-check that concern against the new commit
/cx:ask auth-fix --write apply the fix you proposed
```

The thread keeps the sandbox it started with, so a reviewer stays read-only. Pass `--write` to let Codex edit files on that turn. It supports `--wait` and `--background` and runs in the foreground by default.

The thread reference is its name or a unique prefix of its Codex session ID.

### `/cx:threads`

Lists the threads recorded for this repository with their kind, whether they are idle or busy, how many turns they have had, and the last prompt.

### `/cx:forget`

Removes a thread from the list. The Codex conversation itself is kept, and the command prints the `codex resume` command for it.

```bash
/cx:forget review-2
```

### `/cx:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/cx:transfer
/cx:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/cx:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/cx:status
/cx:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/cx:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/cx:result
/cx:result task-abc123
```

### `/cx:cancel`

Cancels an active background Codex job.

Examples:

```bash
/cx:cancel
/cx:cancel task-abc123
```

### `/cx:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/cx:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/cx:setup --enable-review-gate
/cx:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/cx:review
```

### Hand A Problem To Codex

```bash
/cx:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/cx:adversarial-review --background
/cx:rescue --background investigate the flaky test
```

Then check in with:

```bash
/cx:status
/cx:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/cx:result` or `/cx:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

### Following Up On A Built-In Review

`/cx:review` uses Codex's built-in reviewer. With Codex CLI 0.161.0 the review runs on the thread the plugin records, and a later `/cx:ask` sees the findings: asked to quote its first finding without re-reading any files, Codex returned it word for word. The check is written up in `docs/superpowers/spikes/2026-10-08-native-review-follow-up.md`.

If a later Codex release changes that, `/cx:adversarial-review --name <thread>` is the dependable choice. It is an ordinary prompt turn, so its thread always carries the findings.

## Merging Upstream

```bash
git fetch upstream
git merge upstream/main
npm test
```

Expect conflicts in `plugins/codex/commands/*.md` and `README.md` from the `/cx:` rename. Keep the `cx` side. The plugin directory is still `plugins/codex` so other files merge cleanly.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/cx:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
