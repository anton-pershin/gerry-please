# Architecture and execution invariants

## Domain model

A **delivery** is one verified GitHub webhook identified by `X-GitHub-Delivery`. A **dispatch** is the decision for one delivery/rule pair. A **run** is one durable agent invocation created by a queued dispatch. An **attempt** is one execution of that run; manual retries keep the same run ID and monotonically increase attempt numbers.

A **subject** is an issue, pull request, or repository. `issue_comment` on a PR is normalized to a pull-request subject. A **conversation** is `(repository, subject type, subject number, group name)`. A **conversation session** is additionally scoped by agent, so two agents never resume each other’s runtime context.

A **workflow** is a unique, typed execution instance rooted at an issue. It owns per-agent sessions, a worktree/branch, optional PR identity, turn budget, dependencies, status, and quarantine. Its type (for example `implementation`) is not a singleton: independent issues create independent instances that can execute in parallel. A **dependency** links a parent workflow to a target-repository issue and records the issue-close/PR-merge facts required for resolution.

## Ingress invariants

1. The request body is streamed with a hard byte ceiling and its SHA-256 HMAC is checked before JSON processing or persistence. Delivery IDs must be UUIDs, preventing payload-path traversal.
2. The raw payload is written before the delivery is acknowledged.
3. Delivery IDs are unique. Replays of terminal deliveries return success without creating more runs; `received`/`dispatch_failed` deliveries resume missing dispatch work on redelivery and startup.
4. Dispatch decisions are unique per delivery/rule and record queued, skipped, or duplicate outcomes and reasons.
5. Unsupported repositories and unmatched deliveries are persisted as ignored/completed, not silently dropped.

GitHub does not guarantee exactly-once delivery or ordering. Rules must tolerate events arriving late. SQLite transactions make local deduplication and run creation atomic, but cannot make an agent’s external side effects transactional.

## Rules

Rules are data, not executable code. Event, actions, and repository filters are evaluated first; all `when` conditions must then match. Prompt placeholders use scalar dot paths and do not evaluate JavaScript.

`once_per_subject` places a ledger entry before queueing. Active and successful runs retain it. Definite pre-runtime failures and pre-start cancellation release it; ambiguous runtime-started failures retain it until an operator retries or resolves the run. This prevents repeated labels or comments from starting duplicate implementations after uncertain side effects.

## Queue and ownership

Workers claim queued/retry-waiting runs in creation order using a transaction and a lease owner. Runs in one conversation or workflow cannot execute concurrently. Waiting/completed/quarantined workflows are filtered in SQL, so blocked backlogs do not starve unrelated runs. Independent fresh runs, conversations, and workflow instances can execute up to the configured worker count.

Only one Gerry daemon can serve a data directory. `serve.lock` rejects a second live daemon, while CLI inspection/retry commands remain available. Leases and heartbeats track ownership, and completion/failure/session/workspace mutations check that ownership before follow-on writes.

After the instance lock is acquired, active runs from the previous process become `interrupted`. This is intentionally conservative: the process cannot know whether OpenCode, Hermes, Git, or GitHub completed side effects during the crash window.

## Retry semantics

There are three failure classes:

- **Before runtime startup**: workspace, prompt, configuration, or token acquisition failed. Retry automatically with exponential backoff up to `max_attempts`.
- **Definite provider quota exhaustion**: the runtime returned a structured quota error rather than an ambiguous transport failure. Requeue the same run in `retry_wait`, starting after five minutes and doubling the delay on each quota failure up to one hour. These retries do not use the `max_attempts` preparation budget. Preserve the runtime session, worktree, rule ledger, and active workflow/conversation without quarantine. The wait is durable across daemon restarts, consumes no worker, and can be cancelled. Later turns in the same conversation or workflow cannot overtake the waiting turn. OpenCode currently supplies this classification for `provider.quota` errors.
- **Other failures after runtime startup**: the agent may have commented, edited, pushed, or opened a PR. Do not automatically replay. Mark `failed` or `interrupted`, retain artifacts/session/worktree/rule ledger, quarantine any conversation or workflow, and require `runs retry` or `runs resolve` after reconciliation.

An operator retry is a deliberate new attempt, not proof that previous side effects did not happen. Check the issue, PR, branch, and response/events first. A provider-quota retry is different: it resumes the same recorded session after a definite provider response instead of starting a replacement workflow.

## Persistent discussions

Conversation creation and turn consumption are transactional. Every queued turn increments the group budget; skipped turns over budget do not execute. Failed turns still count because automatic loop prevention should also bound repeated failures.

Each runtime session ID is persisted immediately when reported, not only at completion. It is associated with its agent, conversation, runtime name, and a hash of runtime/agent options. Subsequent compatible turns resume that exact session; identity, server, profile, model, toolset, or permission-option changes create a fresh session. OpenCode uses session IDs through the client API. Hermes uses `--resume <session-id>` with one-shot JSONL chat. Explicit same-run retries also resume a recorded partial session, including for originally fresh runs.

Conversation runs share a worktree only when their agents use `workspace: worktree`. Fresh runs never implicitly resume runtime context. Manual retries of a conversation run reuse its conversation session and workspace.

A hidden `<!-- gerry:run=... -->` comment marker links a newly triggered run to its parent. This marker depends on agents following the execution contract; the turn budget remains the safety mechanism when markers are absent.

## Workflow execution

A rule with `workflow_start: true` creates or finds a workflow for its origin issue. Resume rules find an existing instance by origin issue or PR head branch; they never create one implicitly. The workflow ID determines its worktree and `gerry/<workflow-id>` branch, so an implementer opening a PR from that branch creates a durable issue-to-PR link.

Every matching review turn resumes the same compatibility-checked agent session and workspace. Independent workflow IDs have no shared execution lock, permitting parallel implementations. An approving PR review marks the workflow completed without invoking another agent turn.

Workflow failures use the same conservative semantics as conversations: ambiguous failures retain ledgers and quarantine only the affected workflow. Retry/resolution is quarantine-owner checked and cannot clear a newer run’s quarantine.

## Cross-repository dependencies

Workflow agents do not receive cross-repository credentials. During an active run they receive a random per-run capability and loopback broker URL. The broker hashes and validates that capability against the active run, checks an exact `from`/`to` dependency policy, and only then creates an issue using an installation token scoped to the target repository. The App private key remains in the daemon.

Requests are unique by `(workflow, requestKey)`. Existing completed requests return the same issue; an ambiguous creation state fails closed instead of creating a duplicate. A successful request records the dependency and moves the parent to `waiting`, blocking its queued turns without consuming workers.

Issue closure and PR merges are tracked independently so webhook order does not matter. Only merges into the configured default branch are eligible. Each merge observation is preserved, and resolution occurs only after GitHub’s issue timeline confirms a closed event whose commit ID equals the observed PR merge commit. Closing keywords, timestamps, `not_planned` closures, non-default-branch merges, or merge without closure cannot resolve the dependency.

The parent resumes only when every dependency in its current cycle is resolved or explicitly abandoned. A per-workflow/per-cycle internal delivery carries dependency issue/PR/merge-SHA context and reactivates the same workflow. Cycle-scoped idempotency prevents historical dependencies from suppressing later wait/resume rounds. Startup and periodic recovery retry verification and incomplete resume dispatch idempotently.

Ambiguous creation can be reconciled explicitly: `dependencies attach` verifies the marker in the actual GitHub issue and links it, while `dependencies abandon` records that an unresolved request is no longer required. Failed/creating/ambiguous requests otherwise continue to block their cycle.

## Runtime adapter contract

Adapters receive:

- run/agent identity and runtime-specific options;
- a fully rendered prompt and workspace;
- a sanitized environment with a GitHub installation token;
- an optional exact runtime session ID;
- timeout/cancellation and an event sink.

They return an exact session ID, final response, and normalized usage where available. Partial session IDs are preserved on failure when known.

Runtime-specific dependencies are confined to `src/runtimes/`. Queue, rules, persistence, GitHub authentication, and worktrees do not import either runtime.

### OpenCode

The adapter uses `@opencode/client` and can discover the local V2 background service or connect to an explicit URL. Prompt submission is durable admission, not completion; the adapter waits for event-stream readiness, subscribes to session events, fails closed on disconnect, and waits for idle. It rejects permission requests, fetches final session/message snapshots (the durable response is authoritative), and removes GitHub token values from the session shell environment afterward. Interruption, subscription cleanup, and credential cleanup all have deadlines.

OpenCode event streams are live-only. Snapshots supplement them but are not a substitute for retaining the local run files during disconnects.

### Hermes

The adapter invokes `hermes chat --oneshot --query-file ... --format stream-json` with optional profile/model/toolset/skill limits. It never adds `--yolo`. Fresh runs omit `--resume`; conversation turns and explicit same-run retries include the exact prior session ID. JSONL provides assistant text, tools, terminal result, session ID, and token usage; stderr is stored separately. Timeouts terminate the process group and escalate to a forced kill after a grace period.

Hermes CLI is gateway-backed in current versions. If a client is killed, accepted gateway work may continue. Treat timed-out/interrupted Hermes attempts as ambiguous and inspect `hermes sessions`/logs before retrying.

## Workspaces and credentials

Shared runs use the configured canonical checkout. Worktree runs fetch the configured default branch and create `gerry/<run-id>` or `gerry/discussion-<hash>` branches. Git commands are asynchronous, cancellable, and time-bounded; heartbeats cover preparation as well as runtime execution. Existing conversation worktrees are reused only after ownership/mode checks; missing or mixed shared/worktree workspaces fail rather than silently losing isolation.

Worktrees and branches are not automatically removed. This preserves uncommitted changes, unpushed commits, and forensic evidence.

The GitHub App provides short-lived installation tokens scoped to the event’s repository and cached per installation/repository. The same token authenticates worktree fetches and agent Git/GitHub operations. Dependency creation uses a separate target-scoped token inside the daemon after an explicit policy check. Per-run broker capabilities are stored only as hashes and invalidated when execution finishes. A sanitized process environment adds `GH_TOKEN`, `GITHUB_TOKEN`, noninteractive Git settings, and a credential helper that reads the token from the environment. Private App key material and webhook secrets are not included in prompts or agent environments.

## Observability model

SQLite answers “what is queued/running and what owns this conversation?”. Files answer “what exactly happened?”. Run provenance includes delivery, parent run, rule, agent, runtime, workflow/dependency identity, config/prompt hashes and exact prompt/instruction snapshots, attempt, workspace, branch, runtime session, and operator-resolution timestamp. Runtime events and responses are redacted for known token values and common credential shapes before being written to human-facing logs.

Raw delivery/context files intentionally retain issue and discussion content for auditability. Protect them as potentially sensitive data.
