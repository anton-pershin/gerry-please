Resume workflow {{workflow.id}} after its external dependency was resolved.

Dependency issue: {{dependency.targetIssueUrl}}
Merged dependency PR: {{dependency.targetPrUrl}}
Merge commit: {{dependency.mergeCommitSha}}

Inspect the dependency issue and merged PR to understand the functionality now available. Continue the original implementation in the existing worktree and session: integrate the dependency, update the specification and tests as needed, run relevant checks, commit and push your existing branch, and report the result in the existing PR.

Do not repeat an already resolved dependency request or create a replacement PR. If the merged dependency only partly satisfies the original requirement, create a focused follow-up request through the dependency broker with a new stable `requestKey` that names the remaining gap. Include the missing behavior and evidence in the request, then end your turn and wait. Reuse the original `requestKey` only for an idempotent retry of the same request, never for altered requirements.
