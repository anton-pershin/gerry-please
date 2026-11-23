# Operations and recovery

## Daily inspection

```sh
bun run src/cli.ts status
bun run src/cli.ts workflows list
bun run src/cli.ts reports list
bun run src/cli.ts reports list --workflow wf_...
bun run src/cli.ts dependencies list
bun run src/cli.ts runs list --limit 50
bun run src/cli.ts runs list --status failed
bun run src/cli.ts runs list --status interrupted
tail -f .gerry/logs/service.jsonl | jq .
```

Open a run’s `summary.md`, then inspect `attempts/<n>/events.jsonl` and `response.md`. Use `deliveries show <id>` to see whether no rule matched, a turn budget or phase guard stopped dispatch, a once-per-subject ledger already existed, or a run was queued. Use `workflows show <workflow-id>` to inspect PR linkage, active/waiting/closed/completed state, investigation/implementation phase, quarantine, and all dependencies. Approval leaves a workflow active; only a merged PR completes it.

## Before any manual retry

Except for definite provider-quota failures handled below, a runtime failure is ambiguous. Check:

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
bun run src/cli.ts workflows abandon wf_...
```

Retry is available for `failed`, `interrupted`, and `cancelled` runs. It adds one attempt to the budget and queues the same run ID. Cancellation only applies before runtime execution (`queued`/`retry_wait`); it does not kill an active runtime.

Resolve is available once for a `failed`/`interrupted` run after you have reconciled external effects. It does **not** execute the agent or change the historical failure state. It records `resolvedAt`, releases once-per-subject ownership, and clears quarantine owned by that run so later work can proceed. Resolved runs cannot subsequently be retried, and resolving an older run cannot clear a newer run’s quarantine. Never use resolve merely to bypass an unread failure.

Once-per-subject ownership is restored on retry unless another run has since acquired it. Conversation retry clears quarantine and reuses the recorded compatible session/workspace. Explicit same-run retries also resume recorded partial sessions for originally fresh runs. Failed turns continue to count toward the discussion budget; an operator retry is an explicit exception to automatic dispatch, not a budget reset.

`workflows abandon` is only for a closed-unmerged workflow with no active run. It preserves the old workflow, runs, sessions, worktree, branch, and PR linkage, but releases its once-per-subject implementation ledgers. A later approval creates a replacement workflow with a new ID, session, worktree, and branch. Abandoned workflows cannot execute runs and do not block replacement creation.

## Process crash

At the next startup, after acquiring the single-instance lock, Gerry marks every previously active run `interrupted` and quarantines its conversation. Do not assume this means the runtime stopped. OpenCode or a Hermes gateway may have finished accepted work. Reconcile external effects before retrying or resolving.

The tree-quiescence guarantee applies to successful OpenCode completion. A failed or interrupted attempt makes a bounded best-effort attempt to reconnect, remove run credentials, and interrupt every discovered session with `resume: false`; it does not wait indefinitely for descendants, and a child can still finish or report afterward. Inspect the session tree, running jobs, worktree, and GitHub effects before retrying or resolving such an attempt. A retry supplies fresh credentials; never treat credential cleanup as proof that a failed session tree stopped.

Incomplete `received`/`dispatch_failed` deliveries are redispatched idempotently during startup. Queued and retry-waiting runs remain durable. No active agent attempt is automatically resumed after a crash.

## OpenCode upgrades and persistent services

OpenCode agents require server and client 2.3.0 or newer. `doctor` and run admission reject older servers. By default, Gerry uses its own service under `<data_dir>/opencode-service/` rather than the user's shared OpenCode service. The dedicated service has independent registration, service configuration, dynamic loopback port, and database. Upgrading or opening the user's ordinary OpenCode CLI therefore cannot restart Gerry's service. An explicit `base_url` remains externally managed.

Before deploying the dedicated runtime, reconcile active runs and old OpenCode sessions. Existing worktrees, branches, and GitHub history are preserved, but runtime sessions start fresh because the database and compatibility identity change. The original OpenCode database is not modified or deleted. On first startup, only provider credential tables are copied into the dedicated database; sessions, messages, jobs, inboxes, automation, and event history are excluded so no old work can resume in the new process. Treat the dedicated database and registration as credential-bearing operational state, and back them up accordingly. Do not copy an old service registration manually.

To restart the dedicated service, stop only its registered process and then start Gerry normally; never use the user's default `opencode service restart` as a Gerry recovery operation. Service environment changes are not retroactive: a healthy registered service is reused until it is stopped. `doctor`, `validate --check`, and disconnect recovery can start or replace the dedicated service and are not read-only health checks.

Run `bun run test/opencode-service-smoke.ts` to verify isolated startup, blocked personal `gh` fallback, bot Git identity, and preservation of the normal service. Optional `OPENCODE_SMOKE_PROVIDER` plus `OPENCODE_SMOKE_MODEL` checks a minimal provider call, `OPENCODE_SMOKE_AGENTS` checks a comma-separated list of custom agents, and `OPENCODE_SMOKE_OLD_SESSION` verifies that an old session is absent from the isolated database. The script creates and stops only its own disposable service.

Activity-aware completion waits for every tracked background job, including jobs left by older runs. If an existing session has a legacy persistent server registered as an OpenCode background shell, stop that process during an active agent turn and let the parent consume its completion report. There is no safe `shell.remove` detach operation. Verify that the jobs API no longer lists the old process. A detached service has no tracked completion report that can resume the parent after Gerry cleans run credentials.

## Managed report hosting

When the `reports` configuration section is present, Gerry starts one static listener on the configured address (port `8123` in the example). Both HTTP listeners must bind successfully before workers start; a bind failure closes the other listener, SQLite, and the instance lock. Stop any legacy process on the report port before starting Gerry. Existing manually detached servers are not adopted or killed automatically.

Workflow agents receive `GERRY_REPORT_PUBLISH_URL` and publish through the private main listener, for example:

```sh
curl --fail-with-body -X POST "$GERRY_REPORT_PUBLISH_URL" \
  -H "Authorization: Bearer $GERRY_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"bpe","directory":"outputs/pr14-bpe"}'
```

The response contains the public URL prefix. Publish each distinct report directory under a different lowercase hyphenated name. Repeating the same request from one run is idempotent. To replace a publication atomically, use the same name with `"replace": true`; failed validation leaves the previous mapping intact. Only `GET` and `HEAD` are available on the static listener, and no directory listing is provided.

Publication mappings survive Gerry restarts, but the static listener is available only while Gerry is running. Merged and closed-unmerged PR events unpublish every name for the matching workflow in the same transaction as the lifecycle change. Duplicate close events are no-ops. Reopening does not restore old URLs; an active run must explicitly republish with `replace: true`. Publication after terminal workflow state is rejected.

Use `reports list [--workflow wf_...]` to inspect active and historical mappings. Use `reports unpublish wf_... <name>` for an idempotent manual cleanup. Unpublishing never deletes report files, worktrees, branches, sessions, or run artifacts. Because files are served directly from their registered worktree directories, removing or changing those directories later can make active URLs unavailable; preserve them for as long as the reports are needed.

The report origin can expose sensitive generated content. Restrict its network reach and proxy only `/reports/` if needed. The `/agent/` publication endpoint remains private and must never be proxied publicly.

## Configuration errors

`runs` records pin the config hash. If the file changes while runs are queued, restart only after validating the new file. Older queued runs fail with a configuration-change error rather than executing with mixed definitions.

Prompt/instruction contents are snapshotted at dispatch, so later file edits do not change an existing queued run. Treat them as production configuration anyway: review changes as carefully as code and keep the data directory’s hashes/artifacts for provenance.

## PR review readiness

The reviewer is dispatched by `pull_request.ready_for_review`, not by `opened` or `synchronize`. Implementation PRs remain draft while CI-dependent work is unfinished. If no review arrives, confirm that CI runs for draft PRs, inspect checks for the exact head, and verify that the implementer marked the PR ready after they passed. To request review for an existing non-draft PR under this policy, convert it to draft and then mark it ready. A failed check should be fixed before readiness; do not use a review run as a substitute for CI.

## Investigation before implementation

With the investigation rules enabled, a human-applied `requires-investigation` label starts the implementation workflow in `investigation`. The implementer posts its SDD investigation to the origin issue but does not implement or open a PR. Continue the discussion only with comments that explicitly tag `@implementer`; untagged comments do not create a turn. The maintainer remains mention-only.

Applying `approved` through the authorized human gate changes the same workflow to `implementation` and queues the implementation turn. The existing implementer session, worktree, branch, and issue discussion are retained. The old investigation label does not need to control routing: after the phase transition, further investigation-comment dispatches are skipped. Use `workflows show <workflow-id>` to inspect the current phase and `deliveries show <delivery-id>` to inspect a phase-mismatch skip.

## Waiting on dependencies

A workflow in `waiting` is paused without consuming a worker. Confirm its dependency issues and PRs with `workflows show <workflow-id>`. A dependency resolves only after a completed issue closure and its linked merged PR are both observed. Check that the dependency PR body contains a closing reference such as `Closes #456` and that the issue was not closed manually long before the merge. When `commit_id` is present, it must match the merge SHA. When squash merging leaves it null, the issue-close actor must match the PR merger and close within five minutes.

When dependency discussion is configured, `@implementer` comments can run discussion-only turns while the workflow remains `waiting`. Applying `ready-for-human-approval` closes those turns and broker replies without approving implementation; remove it to reopen discussion. The human-only `approved` label remains the implementation gate.

When every dependency resolves, one internal `dependency-resume-*` run is queued. Startup recovery retries incomplete resume delivery. If the merged change is incomplete, the resume turn can create a focused follow-up with a new request key; this starts the next dependency cycle while preserving the workflow, session, worktree, branch, and PR. A `failed` dependency request is intentionally not retried automatically because GitHub issue creation may have completed during the failure window. Reconcile it explicitly:

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

Pre-runtime failures enter `retry_wait` with exponential backoff. Check `doctor` and service logs. Other runtime-start failures do not auto-replay, even when they look transient, because the exact point of failure is not a safe transaction boundary.

GitHub App installation tokens have a fixed lifetime of about one hour; Gerry cannot extend it. At run startup, Gerry reuses a cached token only when its remaining lifetime covers the agent's configured attempt timeout plus one minute. Otherwise, it forces Octokit to issue a fresh token rather than accepting Octokit's own cached copy. This prevents a long attempt from starting with a token that is already near expiry.

During an active run, the provided `gh` command and Git credential helper obtain credentials from Gerry's loopback broker at the start of each new command or Git authentication request. The broker authenticates the per-run capability, derives the repository and installation from the run record, and stops issuing tokens when the run ends. A process that remains alive across the token deadline retains its original token: split long operations such as `gh pr checks --watch` into shorter repeated checks. Do not automatically replay arbitrary mutating commands after an ambiguous authentication failure.

A structured provider-quota error also enters `retry_wait`, but preserves the active workflow and retries indefinitely: after five minutes initially, then with delays doubled up to one hour. The provider response does not necessarily include a reset timestamp, so these attempts are periodic probes rather than a claim about the exact reset time. `runs show` displays `availableAt`, and `summary.md` displays the next attempt time. The same run, session, worktree, and branch resume when an attempt is due. Restarting Gerry does not cancel the wait, and an idle retry wait consumes no worker. Use `runs cancel` if waiting is no longer desired; use `runs retry` once for a quota run that already reached `failed` under an older Gerry version.

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
- Use TLS at the reverse proxy and retain the default loopback bind. Expose `/webhooks/github` and optionally `/health`, but never proxy `/agent/` endpoints; their per-run capabilities are intended only for local agents.
- If managed reports are enabled, keep the static listener on a separate origin and restrict access to generated content. Expose only `/reports/` through its proxy, and ensure the configured `public_base_url` matches that public origin.
- Keep runtime provider credentials in runtime-managed profiles/configuration.
- Set Hermes unattended/single-query approvals to deny; avoid `--yolo` and broad shell access.
- Consider runtime container backends for untrusted repositories or issues. Worktrees alone do not contain prompt-injection-driven host commands.
- Monitor `failed`, `interrupted`, `retry_wait`, and conversation-limit skips.
- Test webhook delivery and failure recovery in a disposable repository before production use.
