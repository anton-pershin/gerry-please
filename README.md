# Gerry, Please

A small, file-configured backend for multi-agent workflows driven by GitHub webhooks. Agents can run in **OpenCode V2** or **Nous Research Hermes Agent**; the orchestrator, rules, queue, conversations, workflows, dependencies, and audit format are runtime-neutral.

There is no GUI. YAML configures the system, SQLite makes execution durable, and JSONL plus per-run files provide the audit trail.

## What it does

- Verifies GitHub App webhook signatures and durably stores deliveries before acknowledging them.
- Deduplicates GitHub delivery IDs and evaluates declarative event/action/repository/payload rules.
- Starts one agent per matching rule using a rendered Markdown prompt.
- Supports fresh sessions, persistent issue/PR discussions, and workflow-scoped sessions spanning an approved issue and its PR review rounds.
- Runs independent implementation workflows in parallel while serializing turns within each workflow and applying per-workflow turn budgets.
- Links PRs to workflows by head branch and completes workflows on an approving review.
- Supports allowlisted cross-repository dependencies: an implementer can request an issue in another repository, wait, and resume after that issue closes through its linked PR merge.
- Serializes each discussion and applies a shared turn budget across participating agents to stop comment loops.
- Gives coding agents dedicated Git worktrees and branches; preserves them after failure for inspection.
- Uses short-lived GitHub App installation tokens for `gh` and Git operations.
- Records run lineage, configuration/prompt hashes, runtime sessions, events, responses, errors, and usage.
- Automatically retries failures **before** runtime startup. Runtime failures require explicit operator retry because GitHub side effects may already have occurred.

## Architecture

```text
GitHub webhook
     │
     ▼
HMAC verification → raw delivery file → SQLite delivery/dedup record
     │                                      │
     │                                      ▼
     │                           declarative rule dispatcher
     │                                      │
     │               fresh / conversation / workflow / dependency resume
     │                                      ▼
     │                         SQLite durable run queue
     │                                      │
     ▼                           bounded worker pool
  202 response                               │
                                     ┌───────┴────────┐
                                     ▼                ▼
                             OpenCode adapter    Hermes adapter
                             client + events     CLI + JSONL events
                                     │                │
                                     └───────┬────────┘
                                             ▼
                             worktree + installation token + prompt
                                             │
                                             ▼
                         comments, labels, specs, commits, and PRs
                                             │
                                             └──────► new GitHub events
```

GitHub is the agents’ shared collaboration state. Runtime sessions are private working memory, not the system of record.

See [docs/architecture.md](docs/architecture.md) for invariants and [docs/configuration.md](docs/configuration.md) for the complete configuration model.

## Requirements

- Bun 1.3 or newer
- Git and [GitHub CLI](https://cli.github.com/) (`gh`)
- A GitHub App
- OpenCode V2 for OpenCode agents and/or [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent) for Hermes agents
- A local canonical checkout of every configured repository

Hermes provider/model credentials should be configured in the selected Hermes profile. OpenCode provider credentials remain in OpenCode. They are not managed by Gerry.

## Install and configure

```sh
bun install
cp gerry.example.yaml gerry.yaml
cp .env.example .env # or export variables through your service manager
```

Edit `gerry.yaml`:

1. Replace `your-org/your-repo` and the checkout path.
2. Select runtimes and models for your agents.
3. Adjust agent instructions, prompts, permissions, and rules.

All relative paths in `gerry.yaml`, including prompt and instruction paths, resolve relative to the configuration file—not the process working directory.

Export the GitHub credentials:

```sh
export GITHUB_APP_ID=123456
export GITHUB_APP_PRIVATE_KEY_PATH=/secure/path/app.private-key.pem
export GITHUB_WEBHOOK_SECRET='a-long-random-secret'
```

Validate files and integrations:

```sh
bun run src/cli.ts validate
bun run src/cli.ts doctor
```

`validate` is offline. `doctor` additionally contacts GitHub, discovers/checks configured runtimes, and checks `git` and `gh`.

## GitHub App setup

For the example workflow, grant:

| Permission | Access | Purpose |
|---|---|---|
| Metadata | Read | Repository discovery |
| Contents | Read & write | Fetch, commit, and push implementation branches |
| Issues | Read & write | Read/comment on issues and apply labels |
| Pull requests | Read & write | Read discussions and create PRs |

Subscribe to **Issues**, **Issue comments**, **Pull requests**, **Pull request reviews**, and **Pull request review comments** for the complete example. Set the webhook URL to:

```text
https://your-public-endpoint.example/webhooks/github
```

Use the same webhook secret in GitHub and `GITHUB_WEBHOOK_SECRET`. Install the App only on intended repositories. Gerry binds to `127.0.0.1` by default; expose it through a TLS reverse proxy rather than changing it to a public unencrypted listener. Expose only `/webhooks/github` and optionally `/health` through that proxy—never expose `/agent/dependencies`; it is a loopback agent broker.

## Run

```sh
bun run src/cli.ts serve
```

The health endpoint is `GET /health`; GitHub posts to `POST /webhooks/github`.

For local development, `serve --skip-checks` skips startup integration checks. It does not disable webhook signature verification or any agent permission.

Run one Gerry process per data directory. SQLite WAL protects database access, but multi-process worker ownership is intentionally not implemented.

## Example workflows

### Issue approval and implementation

1. A new issue triggers `triage-new-issue` and a fresh OpenCode maintainer session.
2. The maintainer comments and applies `approved` when requirements are actionable.
3. The label event triggers `implement-approved-issue` once for that issue.
4. A fresh Hermes session receives a dedicated worktree and `gerry/<run-id>` branch.
5. The implementer writes `specs/issue-<n>.md`, implements and tests it, pushes the branch, and opens a PR.
6. Gerry associates the PR head branch with the same workflow. Review comments resume the same implementer session and worktree, rather than starting over.
7. Independent issues create independent workflow instances that can run in parallel. An approving review completes the workflow; no stop prompt is needed.

The rule engine does not parse an agent’s natural-language response to infer `approved`; the GitHub label is the explicit handoff.

### Waiting for a dependency in another repository

The example dependency policy allows `your-org/your-repo` to request work in `your-org/dependency-repo`:

1. During a workflow, the implementer POSTs a dependency request to Gerry’s loopback broker using its per-run capability.
2. Gerry checks the exact `from`/`to` policy and creates the issue using a token scoped to the target repository. The agent never receives an installation-wide token or the App private key.
3. The parent workflow enters `waiting` and consumes no worker/model resources. The dependency issue can start an independent implementation workflow in the target repository.
4. Gerry records the dependency issue closure and every linked PR merge observation. It resolves only after GitHub’s issue timeline confirms that the issue’s closed event references the same merge commit from a default-branch PR; closing keywords alone are insufficient.
5. Once **all** dependencies resolve, Gerry queues one internal resume delivery with the dependency issue, merged PR, and merge SHA as context. The same parent session/worktree continues.

Requests are idempotent by `(workflow, requestKey)`, and startup recovery retries unresolved resume dispatch.

### Two agents discussing an issue or PR

The example `maintainer-discussion` and `reviewer-discussion` rules react to `@maintainer` and `@reviewer` mentions. Both use the conversation group `issue-discussion`:

- Each agent has a separate persistent runtime session per repository/subject/group.
- Only one run in the group executes at a time.
- `max_turns: 8` is shared across both agents, including failed turns.
- Agents are instructed not to mention another agent when the discussion is complete.
- Every agent comment should include `<!-- gerry:run=<id> -->`, which records parent/child lineage when it triggers another run.

Mentions and filters are configuration conventions, not a natural-language router. A mention triggers a rule only when its declarative condition matches.

## Operations

```sh
# State counts, workflows, dependencies, and recent runs
bun run src/cli.ts status
bun run src/cli.ts workflows list
bun run src/cli.ts workflows show wf_...
bun run src/cli.ts dependencies list
bun run src/cli.ts runs list
bun run src/cli.ts runs list --status failed --limit 20

# Full record and audit directory
bun run src/cli.ts runs show run_...

# Explicit retry after checking comments, branches, and PRs for prior side effects
bun run src/cli.ts runs retry run_...

# Cancel work that has not started; no forced termination of active agents
bun run src/cli.ts runs cancel run_...

# After reconciling an ambiguous failure, release its ledger/conversation quarantine
# without executing another attempt (the run remains marked failed/interrupted)
bun run src/cli.ts runs resolve run_...

# Why a delivery did or did not dispatch
bun run src/cli.ts deliveries show DELIVERY_UUID
```

Run IDs may be abbreviated when unambiguous. Configuration is loaded at startup; validate and restart the service after changing it. Existing queued runs pin the configuration hash plus exact prompt/instruction snapshots and fail rather than silently executing under a different configuration. Startup also resumes incomplete delivery dispatch and marks previously active runs interrupted; ambiguous failures retain once-per-subject ownership and quarantine their conversation until `runs retry` or `runs resolve`.

## File-based observability

The default data directory is `.gerry/`:

```text
.gerry/
├── gerry.sqlite                 # runs, workflows, sessions, dependencies, leases, turn budgets
├── serve.lock                   # live single-instance daemon lock (when serving)
├── logs/
│   └── service.jsonl            # ingress, dispatch, worker, and lifecycle events
├── deliveries/
│   └── <delivery-id>.json       # original verified payload
└── runs/<run-id>/
    ├── summary.md               # current human-readable state and provenance
    ├── context.json             # normalized context plus original payload
    ├── prompt.md                # complete execution contract and rendered task
    ├── response.md              # final redacted assistant response, if any
    └── attempts/<n>/
        ├── prompt.md
        ├── events.jsonl         # runtime-neutral timestamped events
        ├── stderr.log           # Hermes diagnostics, when applicable
        └── result.json          # Hermes terminal result, when available
└── worktrees/                   # preserved implementation workspaces
```

JSONL is intended for `jq`, `rg`, and log tooling; `summary.md` is the quickest manual entry point. Files are created with owner-only permissions where applicable. Issue content and tool output can still be sensitive, so protect the entire data directory and include retention in your deployment policy.

See [docs/operations.md](docs/operations.md) for recovery procedures.

## Security and reliability boundaries

- **A worktree is isolation from concurrent Git edits, not a security sandbox.** Agents can execute host commands with the service user’s authority. Use OS accounts and, for stronger containment, runtime-provided container backends.
- `workspace: shared` is a convention for non-coding agents, not enforced read-only access. A conversation group cannot mix shared and worktree agents. Use runtime permissions/deny rules and Hermes write restrictions as defense in depth.
- OpenCode `ask` requests are rejected automatically. Hermes runs without `--yolo`; configure unattended/single-query approvals to `deny` and use explicit profile allowlists.
- Only baseline environment variables and per-agent `pass_environment` entries are forwarded. Allowlisting a provider key also makes it available to agent-invoked shell commands.
- Agents receive `GH_TOKEN`/`GITHUB_TOKEN` and a Git credential helper. Each token is requested only for the event’s repository, expires automatically, and is never intentionally logged; its permissions still come from the App installation. Cross-repository dependency issues are created by Gerry through a per-run capability broker and exact repository allowlist, not by giving agents broader tokens.
- Delivery ingestion and run creation are idempotent. Incomplete dispatch is resumed on redelivery/startup without duplicating existing rules. Arbitrary agent side effects are **not exactly-once**. Inspect GitHub before retrying or resolving a failed runtime attempt.
- A crash marks active runs `interrupted`; it never blindly resumes them. Ambiguous failures retain rule ledgers and quarantine conversations. An external runtime may still have completed work after the crash.
- Configuration changes require restart. There is no GUI, distributed queue, automatic worktree deletion, or automatic approval interface.

## Development

```sh
bun run check       # strict TypeScript + all tests
bun test            # tests only
bun run test:coverage
```

The suite uses temporary repositories, signed webhook requests, SQLite stores, and fake runtimes. No live model or GitHub credentials are needed.

## License

MIT
