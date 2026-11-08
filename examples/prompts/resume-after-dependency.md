Resume workflow {{workflow.id}} after its external dependency was resolved.

Dependency issue: {{dependency.targetIssueUrl}}
Merged dependency PR: {{dependency.targetPrUrl}}
Merge commit: {{dependency.mergeCommitSha}}

Inspect the dependency issue and merged PR to understand the functionality now available. Continue the original implementation in the existing worktree and session: integrate the dependency, update the specification and tests as needed, run relevant checks, commit and push your existing branch, and report the result in the existing PR.

Do not create a duplicate dependency request or a replacement PR. If the merged dependency does not actually satisfy the original requirement, explain the remaining gap rather than treating the workflow as unblocked.
