# Named persistent Codex threads

Date: 2026-10-08
Status: approved design, ready for an implementation plan
Upstream: `openai/codex-plugin-cc` at `db52e28` (plugin version 1.0.6)

## Goal

Let Claude Code hand work to Codex and then come back to that exact Codex
conversation later, by name, as many times as needed, with several such
conversations alive at once. The motivating exchange:

    > use codex to run a review of this branch
    ...later...
    > ask that codex reviewer to elaborate on what they meant by XYZ

Upstream cannot do this. Reviews run on ephemeral threads that are never
resumable, and `task --resume-last` can only reach the single most recent
task thread from the current Claude session.

## Decisions already made

| Decision | Choice |
|---|---|
| Where the code lives | Fork of `openai/codex-plugin-cc` at `github.com/cannonpalms/codex-plugin-cc`, branch `named-threads`, `upstream` remote kept for merges |
| Plugin name and command prefix | Renamed from `codex` to `cx` so it installs beside the upstream plugin. The directory stays `plugins/codex` to keep upstream merges clean |
| Thread lifetime | Per repository. A thread started in one Claude session is addressable from any later session in the same repository |
| Divergence from upstream | Minimal. Every upstream command, the rescue subagent, transfer, and the stop-time review gate keep working. New behaviour is added beside them |

## What Codex already provides

The plugin talks to `codex app-server` over JSON-RPC. These methods, all
already used by upstream, are sufficient:

- `thread/start` with `ephemeral: false` writes the thread to disk.
- `thread/name/set` names it, which also makes it findable in the Codex TUI.
- `thread/resume` followed by `turn/start` sends a new message into an
  existing thread with its full history.
- `review/start` with `delivery: "inline"` runs Codex's built-in reviewer as a
  turn inside the thread passed to it.
- `thread/list` filters by repository and name.

Nothing in this design needs a Codex feature upstream does not already call.
Tested against Codex CLI 0.161.0. The app-server protocol is experimental and
unpinned, which is an accepted risk inherited from upstream.

## Design

### 1. Thread registry

New module `plugins/codex/scripts/lib/threads.mjs`. It owns one file,
`threads.json`, in the same per-repository state directory that
`state.mjs` resolves for `state.json`. It is a separate file on purpose: the
`SessionEnd` hook deletes that session's jobs from `state.json`, and threads
must survive that.

File shape:

```json
{
  "version": 1,
  "counters": { "review": 3, "adv": 0, "task": 1 },
  "threads": [
    {
      "name": "review-3",
      "threadId": "01a11c00-f248-7fb1-b6d2-8025288e570c",
      "kind": "review",
      "sandbox": "read-only",
      "model": null,
      "createdAt": "2026-10-08T15:04:05.000Z",
      "updatedAt": "2026-10-08T15:09:41.000Z",
      "createdBySession": "sess-abc",
      "lastPrompt": "Review the changes in this branch compared to main",
      "lastJobId": "review-m2x1-ab12cd",
      "turns": 2,
      "activeJobId": null
    }
  ]
}
```

Field rules:

- `name` is unique per repository, case-sensitive, matches
  `^[a-z0-9][a-z0-9._-]{0,63}$`. A user-supplied name outside that pattern is
  rejected with the pattern in the error.
- `kind` is one of `review`, `adversarial-review`, `task`.
- `sandbox` is `read-only` or `workspace-write`, the value the thread was
  started with. Follow-ups default to it.
- `model` is the model the thread was started with, or null for Codex's
  default. Follow-ups default to it.
- `threadId` is null between name reservation and the app server reporting
  the thread id, and set as soon as it is known.
- `turns` counts turns sent through this plugin, including the first.
- `activeJobId` is the plugin job id currently holding the thread, or null.

Module interface, all synchronous file operations like `state.mjs`:

```
loadRegistry(workspaceRoot) -> { version, threads }
saveRegistry(workspaceRoot, registry)
reserveThread(workspaceRoot, { name?, kind, sandbox, model, sessionId, jobId, prompt })
    -> entry   // picks the auto name when name is absent, sets activeJobId = jobId
resolveThread(workspaceRoot, reference) -> entry
    // exact name, else unique threadId prefix (>= 6 chars), else throws
    // "No thread named <ref>. Known threads: a, b, c. Run /cx:threads."
acquireThread(workspaceRoot, name, jobId) -> entry
    // throws if activeJobId points at a job that is queued or running
    // clears a stale lock whose job is finished, cancelled, failed or missing
releaseThread(workspaceRoot, jobId, patch?)
    // clears activeJobId on every entry holding jobId; applies patch
    // (threadId, lastPrompt, lastJobId, turns increment, updatedAt)
listThreads(workspaceRoot) -> entries sorted by updatedAt descending
forgetThread(workspaceRoot, name)
    // throws if the thread is busy
```

Auto names are `<kind-short>-<n>` where kind-short is `review`, `adv`, or
`task` and `n` comes from the `counters` map, which only ever increases, so
a forgotten name is not reused. If the next counter value collides with a
user-chosen name, the counter advances again. Examples: `review-1`, `adv-2`,
`task-7`.

Locking is advisory and file-based, matching upstream's state handling.
Stale-lock detection reads the job's status from `state.json` through the
existing `listJobs`; a job that is absent counts as finished.

### 2. Runtime changes in `codex.mjs`

- `runAppServerReview` accepts `persistThread` and `threadName`. When
  `persistThread` is true it starts the thread with `ephemeral: false` and
  sets the name. It already returns `threadId` and `sourceThreadId`; both are
  kept so the caller can choose which to register (see section 7).
- `runAppServerTurn` is unchanged except that the Codex-side thread name for
  registered threads is `cx:<name>` rather than the upstream
  `Codex Companion Task: <excerpt>` form. `TASK_THREAD_PREFIX` and
  `findLatestTaskThread` stay for the no-session fallback but are no longer
  the primary resume path.

### 3. Runner changes in `codex-companion.mjs`

Both runners already receive `request.jobId` and run in the foreground path
and the detached `task-worker` path, so registry handling lives in them, not
in the command handlers.

`executeReviewRun(request)`:

1. Unless `request.ephemeral`, `reserveThread` with kind `review` or
   `adversarial-review`, sandbox `read-only`, the request model, and
   `request.threadName` if given.
2. Run as today, with `persistThread: true` and `threadName: "cx:<name>"`.
3. On completion, `releaseThread(jobId, { threadId, lastPrompt, lastJobId,
   turns: 1 })`. On failure, `releaseThread(jobId)` and drop the entry if
   `threadId` was never set.

`executeTaskRun(request)`:

1. If `request.threadRef` is set: `resolveThread`, then `acquireThread`.
   `resumeThreadId` is the entry's `threadId`. Sandbox defaults to the entry's
   sandbox unless `request.write` is true. Model defaults to the entry's
   model unless `request.model` is set.
2. Else if `request.resumeLast`: pick the most recently updated registry
   entry of kind `task` that is not busy; fall back to upstream's
   `findLatestTaskThread` only when the registry has none. Then as step 1.
3. Else if `request.ephemeral`: run as upstream does today with
   `persistThread: false` and no registration.
4. Else: `reserveThread` with kind `task`, the chosen sandbox and model, and
   `request.threadName` if given; run with `persistThread: true`.
5. Release as for reviews, incrementing `turns` on a resumed thread.

The `request` object stored for background jobs gains `threadName`,
`threadRef` and `ephemeral` so the worker path sees them.

Cancel (`handleCancel`) calls `releaseThread(job.id)` after marking the job
cancelled.

### 4. Command-line surface of `codex-companion.mjs`

Additions only; every upstream invocation still parses.

```
review              [--name <thread>] ...existing flags
adversarial-review  [--name <thread>] ...existing flags
task                [--name <thread> | --thread <ref>] [--ephemeral] ...existing flags
ask <ref> [--background] [--write] [--model <m>] [--effort <e>] [--json] [prompt | --prompt-file | stdin]
threads             [--json]
forget <name>       [--json]
task-resume-candidate [--json]   // now registry-backed, see below
```

- `task --name` and `task --thread` together is an error. `--thread` with
  `--fresh` is an error. `--resume-last`, `--resume`, and `--fresh` keep their
  upstream meaning.
- `ask` is `task --thread <ref>` with the prompt required. It exists as its
  own subcommand so the slash command and the skill have a verb that cannot
  accidentally start a new thread.
- `threads` prints a table: name, kind, state (`idle` or `busy <jobId>`),
  turns, updated (relative), last prompt (shortened to 48 chars), followed
  by one line `Follow up: /cx:ask <name> <question>`. With no threads it
  prints `No Codex threads in this repository.` `--json` prints the entries.
- `forget` removes the registry entry only. It never deletes the Codex
  thread from disk; the output says so and prints the `codex resume` command
  for the orphaned id.
- `task-resume-candidate` returns the most recently updated registry entry of
  kind `task` across all sessions, with `name`, `threadId`, `updatedAt`,
  `lastPrompt`, and `ageLabel` (for example `2 hours ago`), so the rescue
  command can show a meaningful question.

### 5. Output changes in `render.mjs`

Every rendered task, review and adversarial-review result, and every stored
result shown by `result`, ends with a thread block when the job has a
registered thread:

```
Thread: review-3 (01a11c00-f248-7fb1-b6d2-8025288e570c)
Follow up: /cx:ask review-3 <question>
Resume in Codex: codex resume 01a11c00-f248-7fb1-b6d2-8025288e570c
```

Ephemeral runs keep upstream's output unchanged. `status` adds a `thread`
column with the name when present.

### 6. Slash commands, agent and skills under `plugins/codex`

Rename: `/codex:` becomes `/cx:` in every command, skill, agent, README,
script message and test; `codex:codex-rescue` becomes `cx:codex-rescue`;
`plugin.json` name becomes `cx`; `marketplace.json` name becomes `cx` and its
single plugin entry becomes `cx`. Install is then
`/plugin marketplace add cannonpalms/codex-plugin-cc` and
`/plugin install cx@cx`. Hook names, environment variable names and the
`plugins/codex` directory do not change.

New command files:

- `commands/ask.md`: takes `<ref> [--wait|--background] [--write] <prompt>`.
  With neither flag it runs in the foreground; a follow-up is usually short.
  Runs `codex-companion.mjs ask "$ARGUMENTS"`, returns stdout verbatim, does
  not fix anything. Background launch mirrors `review.md`.
- `commands/threads.md`: `!`-runs `codex-companion.mjs threads "$ARGUMENTS"`,
  presents the table as-is.
- `commands/forget.md`: `!`-runs `codex-companion.mjs forget "$ARGUMENTS"`.

Changed command files:

- `review.md` and `adversarial-review.md`: document `--name`, and after a
  foreground run tell the user the thread name and that `/cx:ask` continues it.
- `rescue.md`: the resume question shows the candidate's name, age and last
  prompt, for example `Continue thread task-4 (2 hours ago: "fix the flaky
  test")`. `--resume` still means that thread. A new `--thread <ref>` is
  forwarded to the subagent and on to `task --thread`.
- `status.md` and `result.md`: mention the thread line.
- `setup.md`: unchanged apart from the prefix.

`agents/codex-rescue.md` and `skills/codex-cli-runtime/SKILL.md`: pass
`--thread <ref>` and `--name <thread>` through to `task`; `--resume` maps to
`--resume-last` as before.

New skill `skills/cx-follow-up/SKILL.md`, model-invocable, with a description
that triggers on phrases like "ask that reviewer", "tell codex to", "have the
codex thread", "continue the codex review", "what did codex mean by". Its
body instructs Claude to:

1. Run `codex-companion.mjs threads --json`.
2. Choose the thread: an explicit name wins; otherwise the most recently
   updated thread whose kind matches the user's wording (reviewer means
   `review` or `adversarial-review`); otherwise the most recent thread. If two
   candidates are equally plausible, ask with `AskUserQuestion` once.
3. Run `codex-companion.mjs ask <name> "<the user's question, verbatim>"`
   and return stdout verbatim. Never answer on Codex's behalf.
4. If the registry is empty, say so and suggest `/cx:review` or `/cx:rescue`.

The stop-review-gate hook passes `--ephemeral` to `task`.

### 7. Native review follow-up

The goal is that a follow-up reaches the same model session that did the
review. For adversarial reviews and tasks that is the thread the plugin
started. For `/cx:review` it is not: Codex runs the built-in reviewer in a
sub-agent session of its own and hands the requesting thread only the final
write-up.

`runAppServerReview` therefore looks the reviewer's session up after the
review, with `thread/list` filtered to `sourceKinds: ["subAgentReview"]` and
matched on `parentThreadId`, and returns it as `reviewerThreadId`. The
registry records that id. The reviewer's session gets the Codex name
`cx:<name>` and the requesting thread becomes `cx:<name> (request)`. If no
reviewer session is reported, the requesting thread is registered instead.

Findings and the evidence are in
`docs/superpowers/spikes/2026-10-08-native-review-follow-up.md`.

### 8. Testing

Runner: `npm test` (node's built-in runner). Baseline on the fork before any
change: 91 tests, 90 pass, 1 fails. The failure,
`collectReviewContext skips untracked directories in working tree review`,
is upstream's and unrelated; it stays failing and is excluded from the
done criteria.

New tests:

- `tests/threads.test.mjs`: registry unit tests for auto naming, name
  validation, uniqueness, reserve and release, busy rejection, stale-lock
  clearing when the job is finished or missing, prefix resolution,
  forget-while-busy rejection, and that `saveState` and the session-end
  cleanup never touch `threads.json`.
- `tests/runtime.test.mjs` additions through the fake Codex fixture:
  review and adversarial-review create non-ephemeral threads with the
  `cx:<name>` name and register them; `task --name`; `ask` resumes the right
  thread with the thread's sandbox and model; `ask --write` widens the
  sandbox; `ask` on a busy thread fails with the job id; `ask` on an unknown
  name lists known names; `threads` output with none, one idle, and one busy;
  `forget`; `task --ephemeral` registers nothing; `--resume-last` prefers the
  registry; a thread from another session id is still resumable; background
  `ask` goes through the worker and releases the lock; cancel releases the
  lock; rendered output carries the thread block.
- `tests/commands.test.mjs` additions: source-text assertions for `ask.md`,
  `threads.md`, `forget.md`, the follow-up skill, and that no file under
  `plugins/codex` still says `/codex:` or `codex:codex-rescue`.

Two upstream tests encode the old per-session rule and change meaning:
`task --resume-last does not resume a task from another Claude session` and
`task --resume-last ignores running tasks from other Claude sessions`. The
first is rewritten to assert the opposite (another session's finished task
thread is resumable). The second keeps its intent, a running thread is never
resumed, but asserts the busy error instead of silent fallback.

The fixture already implements `thread/start` with `ephemeral`,
`thread/name/set`, `thread/list`, `thread/resume`, `review/start` inline and
detached, and `turn/start`; no fixture changes are expected.

### 9. Documentation

`README.md` is rewritten for `cx`: install, the thread model, `ask`,
`threads`, `forget`, the spike's conclusion about native review follow-ups,
and a short "merging upstream" note (fetch `upstream`, merge `main`, resolve
the prefix rename conflicts in command files). `CHANGELOG.md` gets a 1.1.0
entry. `package.json` and both manifests move to 1.1.0.

## Out of scope

Renaming threads, deleting Codex threads from disk, threads shared across
repositories, pinning a Codex CLI version, and changes to the review gate
beyond the `--ephemeral` flag.

## Risks

- Each resumed turn re-sends the thread's history, so a long-lived reviewer
  costs more per question over time. Acceptable for tens of follow-ups.
- The app-server protocol changes with Codex releases. A breaking change will
  break upstream too; merge their fix.
- Registry and job state are plain files with no cross-process lock. Two
  simultaneous starts could race on auto-name allocation. Upstream's job
  state has the same property; accepted.
