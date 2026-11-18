# Configuration reference

Copy `gerry.example.yaml` to `gerry.yaml`. Unknown fields are validation errors. Configuration is read at startup; relative paths resolve from the config file directory.

## `server`

| Field | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | HTTP bind address |
| `port` | `3789` | HTTP port |
| `data_dir` | `.gerry` | SQLite, logs, deliveries, runs, and worktrees |
| `workers` | `2` | Maximum concurrent runs, 1–32 |
| `max_body_bytes` | `10485760` | Maximum webhook request size |

## `github`

The App credential values come from the environment, not YAML:

- `app_id_env` (default `GITHUB_APP_ID`)
- `private_key_path_env` (default `GITHUB_APP_PRIVATE_KEY_PATH`)
- `webhook_secret_env` (default `GITHUB_WEBHOOK_SECRET`)

The private-key variable contains a **file path**. The webhook secret variable contains the secret itself.

## `repositories`

A map keyed by exact `owner/repository` full name:

```yaml
repositories:
  acme/widgets:
    path: /srv/checkouts/widgets
    default_branch: main
```

The checkout must be a Git repository with an `origin` remote for worktree runs. Shared runs do not fetch automatically.

## `runtimes`

### OpenCode

```yaml
runtimes:
  opencode:
    type: opencode
    # Default true: use a Gerry-owned isolated local service.
    dedicated_service: true
    # Optional explicit external server instead of the dedicated local service.
    base_url: http://127.0.0.1:4096
    # Optional bearer token variable for an explicit server.
    token_env: OPENCODE_TOKEN
```

With `dedicated_service: true`, Gerry starts or reuses its own OpenCode service under `<data_dir>/opencode-service/`. It has a dedicated registration file, service configuration, dynamic loopback port, and database. It does not discover, replace, or restart the user's normal OpenCode service. Personal `gh` configuration, GitHub token environment variables, host Git configuration, and host credential helpers are not inherited. Ordinary non-service OpenCode resources such as agents, commands, skills, plugins, and instructions are linked without copying the user's service port, password, or saved service environment.

On first startup, an existing OpenCode database can supply a one-time snapshot of provider credential tables so model access continues to work. Sessions, messages, jobs, inboxes, automation, and event history are removed from the copy; the original database is never modified. The new service therefore has no existing session it can resume. Enabling the dedicated service changes the runtime compatibility identity, so existing workflows deliberately start fresh runtime sessions while retaining their worktrees, branches, and GitHub discussions. `dedicated_service: false` is a legacy escape hatch that reuses the user's shared service and does not provide this isolation.

An explicit `base_url` bypasses local service management. The external server must provide equivalent protection against fallback to personal `gh` and Git credentials. OpenCode **2.3.0 or newer** is required in all modes. Gerry checks this during local service discovery, integration checks, and every run before prompt admission. A run does not complete merely because its parent session is idle: Gerry waits for all descendant subagents, every tracked shell job, and their completion reports. It also revalidates the complete descendant tree on both sides of the check, requiring unchanged membership and server-authoritative durable log watermarks, no active execution anywhere in the tree, and empty jobs/inbox so a consumed report, active child, or newly created job cannot slip through a stale snapshot and wake a session after credential cleanup. Persistent services such as report servers must be launched by a foreground command that detaches them with `nohup` and redirected stdin/stdout/stderr; do not leave them as tracked OpenCode background jobs.

### Hermes

```yaml
runtimes:
  hermes:
    type: hermes
    command: hermes # absolute path also accepted
```

## `agents`

Common fields:

| Field | Default | Meaning |
|---|---|---|
| `runtime` | required | Key in `runtimes` |
| `instructions` | none | Markdown file prepended to every task |
| `workspace` | `shared` | `shared` or `worktree` |
| `timeout_seconds` | `1800` | Runtime attempt timeout; cached GitHub tokens must cover this duration plus one minute or they are refreshed |
| `max_attempts` | `3` | Automatic preparation-attempt budget; provider-quota waits are not bounded by it |
| `retry_backoff_seconds` | `30` | Initial exponential backoff |
| `pass_environment` | `[]` | Additional process environment names forwarded to the runtime |
| `env` | `{}` | Literal additional environment values; do not use for secrets |
| `options` | `{}` | Runtime-specific agent options |

OpenCode options:

- `agent`: configured OpenCode primary agent ID, such as `build`.
- `model`: `provider/model` with optional `#variant`.
- `permissions`: ordered OpenCode V2 `{action, resource, effect}` rules. Any resulting `ask` is rejected by Gerry.

Hermes options:

- `profile`: isolated Hermes profile.
- `provider` and `model`: launch overrides.
- `toolsets`: string array sent as comma-separated `--toolsets`.
- `skills`: string array; each is passed with `--skills`.
- `max_turns`: Hermes model/tool iteration limit per agent turn.

Unknown runtime options are errors. Gerry does not expose a `yolo` option.

### Agent GitHub credentials

No additional configuration is required. Gerry places a temporary `gh` wrapper, Git credential helper, and managed Git configuration on each run's command path. New commands use the loopback `/agent/github/token` broker to obtain same-repository installation tokens while the run is active. The broker uses the run's capability and stored identity; agents cannot select another repository. Commits use the explicit `gerry-please[bot]` author and committer identity rather than the host Git identity. The wrapper and run-specific `gh` configuration directories are removed and the capability is invalidated after the attempt. Cleanup retains a helper-free Git configuration, so later commands cannot silently fall back to a host credential helper. An individual long-running process keeps its starting token, so use repeated bounded checks rather than a single watch that outlives the token.

## `rules`

```yaml
rules:
  - name: implement-approved-issue
    enabled: true
    on:
      event: issues
      actions: [labeled] # optional; omit for every action
    repositories: [acme/widgets] # optional; default all configured repos
    when:
      - path: label.name
        equals: approved
    agent: implementer
    prompt: examples/prompts/implement.md
    session: workflow # fresh (default) | conversation | workflow
    workflow: implementation # workflow type; defaults to rule name
    workflow_start: true # creates or finds the workflow for the origin issue; default false
    workflow_phase: implementation # start: enter this phase; resume: require this phase
    max_turns: 20 # per workflow instance; default 12
    once_per_subject: true
```

Names must be unique. `conversation` is valid only with `session: conversation`; `workflow`, `workflow_start`, and `workflow_phase` are valid only with `session: workflow`. Persistent conversations are intended for `issue_comment`, `pull_request_review`, and `pull_request_review_comment` rules. Workflow agents must use `workspace: worktree`.

### Conditions

Each condition has a dot-separated `path` and exactly one operator:

| Operator | Meaning |
|---|---|
| `equals` | Strict scalar/value equality |
| `not_equals` | Negated strict equality |
| `contains` | String substring or array membership |
| `not_contains` | Negated containment |
| `in` | Actual value equals any array entry |
| `exists` | Boolean: value is present and non-null |

`ignore_case: true` applies to string `contains`/`not_contains`. Conditions use the webhook payload as their root, plus `event`, `action`, `delivery_id`, and normalized `subject`.

Examples:

```yaml
when:
  - path: comment.body
    contains: "@maintainer"
    ignore_case: true
  - path: issue.pull_request
    exists: false
  - path: label.name
    in: [approved, ready-for-agent]
```

Avoid unbounded bot-to-bot rules. Persistent rules should always have a finite shared `max_turns` and explicit participant filters.

### Prompt placeholders

Use `{{dot.path}}` in Markdown prompt files. Strings, numbers, and booleans are interpolated; missing/null values become empty text; objects cause validation-at-run errors.

Common values include:

- `issue.number`, `issue.title`, `issue.body`
- `pull_request.number`, `pull_request.title`, `pull_request.body`
- `comment.body`, `comment.user.login`
- `label.name`, `sender.login`, `repository.full_name`
- `subject.type`, `subject.number`, `subject.title`, `subject.body`, `subject.url`
- `run.id`, `workspace.path`, `event`, `action`, `delivery_id`
- `workflow.id`, `workflow.type` for workflow runs
- `dependency.targetIssueUrl`, `dependency.targetPrUrl`, `dependency.mergeCommitSha` for dependency resumes

Gerry appends an execution contract with run/workspace/branch/context paths, credential handling instructions, and the comment lineage marker. The complete result is saved as `prompt.md`.

## Sessions and turn limits

- `session: fresh`: create a new runtime session for the run. This is the default and appropriate for independent triage/implementation tasks.
- `session: conversation`: resume a session for this agent in the repository/subject/group. Other agents in the same group keep separate sessions.
- `session: workflow`: resume a session for this agent in a unique workflow instance spanning the origin issue and its PR. A start rule creates the instance; resume rules resolve it by origin issue or PR head branch.

All agents in one conversation group must use the same workspace mode. Runtime/options changes create a compatibility mismatch and start a fresh session rather than resuming a session under stale identity or permissions.

`max_turns` defaults to 12 and is shared by all rules using the same conversation group or workflow instance. Choose the same value across rules in a group; the currently dispatching rule’s value is checked. A failed turn consumes budget. Reaching the budget records a skipped dispatch and requires operator intervention rather than silently resetting the conversation/workflow. An ambiguous runtime failure separately quarantines the conversation/workflow until an operator retries or resolves that run.

### Workflow rules

`workflow_start: true` marks a rule that creates or finds a workflow for an origin issue. Resume rules leave it `false` (the default) and never create a workflow when no matching instance exists. `workflow` is the type name, defaulting to the rule name. Instances have unique IDs, so the same type can run in parallel for many issues.

A workflow has a lifecycle status and an independent phase. On a start rule, `workflow_phase` selects the phase to enter and also supplies the initial phase when creating the workflow; the default is `implementation`. On a resume rule, it is a guard: Gerry skips dispatch unless the existing workflow is already in that phase. Phase transitions and run creation are transactional, and every start rule still follows the normal lifecycle, quarantine, turn-budget, and once-per-subject checks.

The example supports two implementation paths. `approved` enters `implementation` directly. `requires-investigation` instead enters `investigation`, where the implementer posts its SDD investigation to the origin issue. Only `@implementer` comments on that issue resume investigation discussion. A later human `approved` label enters `implementation` on the same workflow, preserving the implementer session, worktree, branch, and discussion context. Investigation comments arriving after that transition are skipped. Investigation and implementation turns share the same workflow turn budget.

PR events resolve the workflow through `pull_request.head.ref`. Gerry also records the PR number/URL. The example reviewer rule listens only for `pull_request.ready_for_review`; implementers open draft PRs, wait for checks on the exact head, and mark them ready after local checks and CI pass. Unfinished review revisions return to draft before pushing. Approval leaves the workflow active for further turns; a merged PR completes it, while closing without merging marks it closed. Reopening a closed PR reactivates the workflow. Later workflow dispatches are skipped while the workflow is `waiting`, `closed`, `completed`, or `abandoned`, while quarantined, or while another turn is active. `workflows abandon` releases a closed workflow's implementation ledger so a subsequent approval can create a replacement.

## `dependencies`

The optional top-level `dependencies` list defaults to `[]`. Each entry is an exact cross-repository policy:

```yaml
dependencies:
  - from: acme/app
    to: acme/library
    allow_issue_creation: true # default false
    resume: # optional; without it, resolved parents remain waiting
      agent: implementer
      prompt: examples/prompts/resume-after-dependency.md
      workflow: implementation
      max_turns: 20 # default 20
    discussion: # optional; enables maintainer/requester discussion on the dependency issue
      agent: implementer
      prompt: examples/prompts/edit-dependency-issue.md
      workflow: implementation
      max_turns: 20 # default 20
```

Both repositories must be configured and different, each pair may appear only once, and resume/discussion agents must use worktrees. The policy permits—but never requires—the agent to request a dependency issue. The generated execution contract lists only targets with `allow_issue_creation: true` for the run's repository and explicitly forbids every other repository, including upstream third-party libraries. With no enabled targets, it states that no cross-repository requests are allowed and omits generic broker instructions. The agent calls `/agent/dependencies` with its per-run capability and fields `to`, `title`, `body`, and `requestKey`; it never receives cross-repository GitHub credentials.

With `discussion` configured, an `@implementer` comment on the dependency issue queues a discussion-only turn for the requesting implementer. The parent remains `waiting`, while the run reuses its workflow session and worktree. Replies go through `/agent/dependencies/comments` with fields `dependencyId` and `body`; full issue-body replacements go through `PATCH /agent/dependencies/issue` with the same fields. The broker performs the target-repository operation using an installation token scoped to that repository. Body replacements must use the SDD sections `Summary`, `Current situation`, `Desired outcome`, and `Why this matters`, and the broker preserves the hidden dependency marker.

A request puts the parent workflow into `waiting`. Gerry records the dependency issue and waits for both:

1. The dependency issue was closed as completed, not `not_planned`.
2. A linked PR whose body contains a closing keyword such as `Closes #456` merged.

The PR must merge into the configured default branch. Gerry verifies the exact merge commit through GitHub’s issue timeline when `commit_id` is present. For squash merges that leave it null, Gerry additionally verifies the PR’s merged actor, the closing keyword, and that the same actor closed the issue within five minutes of the merge. A non-null mismatched commit is rejected. If the PR endpoint omits its merge SHA, GitHub’s commit-to-PR association must independently confirm the same merged PR and base branch. Closing keywords and timestamps alone are not treated as proof. Every merge observation is retained until the closing merge is verified.

Once all dependencies in the current cycle are resolved, the `resume` configuration queues one internal run per workflow/cycle with dependency issue/PR/merge-SHA context. Every workflow resume receives the same loopback broker URL and a fresh per-run capability as the original implementation turn. If the merged dependency leaves a distinct gap, the resume can create a focused follow-up with a new stable `requestKey`; later dependency rounds use a new cycle and cannot collide with old requests or resume deliveries. Startup retries incomplete verification/resume dispatch without duplicating successful resumes.

Dependency discussion uses labels rather than comment text as its control plane. `ready-for-human-approval` closes discussion before the human's separate `approved` decision. Either label blocks new discussion turns and broker comments. Removing `ready-for-human-approval` reopens discussion; `approved` remains the implementation gate.
