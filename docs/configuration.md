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
    # Optional. Omit to discover/start the local V2 service.
    base_url: http://127.0.0.1:4096
    # Optional bearer token variable for an explicit server.
    token_env: OPENCODE_TOKEN
```

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
| `timeout_seconds` | `1800` | Runtime attempt timeout |
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
    workflow_start: true # creates the workflow for the origin issue; default false
    max_turns: 20 # per workflow instance; default 12
    once_per_subject: true
```

Names must be unique. `conversation` is valid only with `session: conversation`; `workflow` and `workflow_start` are valid only with `session: workflow`. Persistent conversations are intended for `issue_comment`, `pull_request_review`, and `pull_request_review_comment` rules. Workflow agents must use `workspace: worktree`.

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

`workflow_start: true` marks the rule that creates a workflow for an origin issue. Resume rules leave it `false` (the default) and never create a workflow when no matching instance exists. `workflow` is the type name, defaulting to the rule name. Instances have unique IDs, so the same type can run in parallel for many issues.

PR events resolve the workflow through `pull_request.head.ref`. Gerry also records the PR number/URL and completes the workflow when a submitted review has `state: approved`. Later workflow dispatches are skipped while the workflow is `waiting` or `completed`, while quarantined, or while another turn is active.

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
```

Both repositories must be configured and different, each pair may appear only once, and resume agents must use worktrees. The policy permits—but never requires—the agent to request a dependency issue. The agent calls `/agent/dependencies` with its per-run capability and fields `to`, `title`, `body`, and `requestKey`; it never receives cross-repository GitHub credentials.

A request puts the parent workflow into `waiting`. Gerry records the dependency issue and waits for both:

1. The dependency issue was closed as completed, not `not_planned`.
2. A linked PR whose body contains a closing keyword such as `Closes #456` merged.

The PR must merge into the configured default branch, and Gerry verifies through GitHub’s issue timeline that the issue’s closed event references the same merge commit. Closing keywords and timestamps alone are not treated as proof. Every merge observation is retained until the closing merge is verified.

Once all dependencies in the current cycle are resolved, the `resume` configuration queues one internal run per workflow/cycle with dependency issue/PR/merge-SHA context. Later dependency rounds use a new cycle and cannot collide with old resume deliveries. Startup retries incomplete verification/resume dispatch without duplicating successful resumes.
