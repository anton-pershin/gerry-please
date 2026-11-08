# Operations and recovery

## Daily inspection

```sh
bun run src/cli.ts status
bun run src/cli.ts workflows list
bun run src/cli.ts dependencies list
bun run src/cli.ts runs list --limit 50
bun run src/cli.ts runs list --status failed
bun run src/cli.ts runs list --status interrupted
tail -f .gerry/logs/service.jsonl | jq .
```

Open a run’s `summary.md`, then inspect `attempts/<n>/events.jsonl` and `response.md`. Use `deliveries show <id>` to see whether no rule matched, a turn budget stopped dispatch, a once-per-subject ledger already existed, or a run was queued. Use `workflows show <workflow-id>` to inspect PR linkage, active/waiting/completed state, quarantine, and all dependencies.

## Before any manual retry

A runtime failure is ambiguous. Check:

1. `summary.md` and the failed attempt’s events;
2. issue/PR comments, labels, reviews, and checks;
3. `git status`, `git log`, and branch state in the recorded worktree;
4. open PRs from the recorded branch;
5. runtime-native session state when the failure was a disconnect or timeout.

If the previous attempt already opened a PR, prefer a new rule/event for follow-up work or resume/inspect manually rather than replaying the original implementation prompt.

## Retry or cancel

```sh
bun run src/cli.ts runs retry run_...
bun run src/cli.ts runs cancel run_...
bun run src/cli.ts runs resolve run_...
```

Retry is available for `failed`, `interrupted`, and `cancelled` runs. It adds one attempt to the budget and queues the same run ID. Cancellation only applies before runtime execution (`queued`/`retry_wait`); it does not kill an active runtime.

Resolve is available once for a `failed`/`interrupted` run after you have reconciled external effects. It does **not** execute the agent or change the historical failure state. It records `resolvedAt`, releases once-per-subject ownership, and clears quarantine owned by that run so later work can proceed. Resolved runs cannot subsequently be retried, and resolving an older run cannot clear a newer run’s quarantine. Never use resolve merely to bypass an unread failure.

Once-per-subject ownership is restored on retry unless another run has since acquired it. Conversation retry clears quarantine and reuses the recorded compatible session/workspace. Explicit same-run retries also resume recorded partial sessions for originally fresh runs. Failed turns continue to count toward the discussion budget; an operator retry is an explicit exception to automatic dispatch, not a budget reset.

## Process crash

At the next startup, after acquiring the single-instance lock, Gerry marks every previously active run `interrupted` and quarantines its conversation. Do not assume this means the runtime stopped. OpenCode or a Hermes gateway may have finished accepted work. Reconcile external effects before retrying or resolving.

Incomplete `received`/`dispatch_failed` deliveries are redispatched idempotently during startup. Queued and retry-waiting runs remain durable. No active agent attempt is automatically resumed after a crash.

## Configuration errors

`runs` records pin the config hash. If the file changes while runs are queued, restart only after validating the new file. Older queued runs fail with a configuration-change error rather than executing with mixed definitions.

Prompt/instruction contents are snapshotted at dispatch, so later file edits do not change an existing queued run. Treat them as production configuration anyway: review changes as carefully as code and keep the data directory’s hashes/artifacts for provenance.

## Waiting on dependencies

A workflow in `waiting` is paused without consuming a worker. Confirm its dependency issues and PRs with `workflows show <workflow-id>`. A dependency resolves only after a completed issue closure and its linked merged PR are both observed. Check that the dependency PR body contains a closing reference such as `Closes #456` and that the issue was not closed manually long before the merge.

When every dependency resolves, one internal `dependency-resume-*` run is queued. Startup recovery retries incomplete resume delivery. A `failed` dependency request is intentionally not retried automatically because GitHub issue creation may have completed during the failure window. Reconcile it explicitly:

```sh
# If the issue exists, verify its dependency marker and attach it
bun run src/cli.ts dependencies attach dep_... --issue-number 456

# If it is no longer required, abandon it and allow the cycle join to proceed
bun run src/cli.ts dependencies abandon dep_... --reason "Inspected; no issue was created"
```

Attaching verifies the actual issue body marker. Abandonment is an explicit operator decision, not automatic failure recovery. Use a replacement request key only after reconciling the old request.

## Conversation or workflow budget exhausted

The delivery/rule dispatch is `skipped` with a turn-limit reason. Read the discussion and run history. To continue, fix the underlying prompt/loop issue and use a new conversation group or an explicit operational procedure; do not simply raise a large budget and re-enable an uncontrolled mention loop.

## Token or runtime outages

Pre-runtime failures enter `retry_wait` with exponential backoff. Check `doctor` and service logs. Runtime-start failures do not auto-replay, even when they look transient, because the exact point of failure is not a safe transaction boundary.

## Worktree cleanup

There is deliberately no automatic deletion. Inspect first:

```sh
git -C /path/to/canonical/checkout worktree list
git -C /path/to/worktree status
git -C /path/to/worktree log --oneline --decorate -10
```

Preserve uncommitted or unpushed work. After confirming a worktree is no longer needed, remove it with normal Git commands and prune stale administrative entries with `git worktree prune`. Do not recursively delete an unfamiliar worktree.

## Backup and retention

Back up `.gerry/gerry.sqlite`, `.gerry/deliveries/`, `.gerry/runs/`, and service logs together while Gerry is stopped if a point-in-time consistent archive is required. Worktrees may be large and are reproducible only when all changes are committed/pushed; back them up separately when necessary.

Define retention based on issue/PR sensitivity and token/tool output exposure. Redaction covers known credentials, not confidential source code or personal data in webhook content.

## Deployment checklist

- Use a dedicated least-privilege OS user and protect the data directory.
- Install the GitHub App only on intended repositories with only required permissions.
- Use TLS at the reverse proxy and retain the default loopback bind. Expose `/webhooks/github` and optionally `/health`, but never proxy `/agent/dependencies`; its per-run capabilities are intended only for local agents.
- Keep runtime provider credentials in runtime-managed profiles/configuration.
- Set Hermes unattended/single-query approvals to deny; avoid `--yolo` and broad shell access.
- Consider runtime container backends for untrusted repositories or issues. Worktrees alone do not contain prompt-injection-driven host commands.
- Monitor `failed`, `interrupted`, `retry_wait`, and conversation-limit skips.
- Test webhook delivery and failure recovery in a disposable repository before production use.
