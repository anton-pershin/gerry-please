Implement approved issue #{{issue.number}}: {{issue.title}}

Approved requirements:

{{issue.body}}

Create `specs/issue-{{issue.number}}.md` in your assigned branch. The specification must record the requirements, proposed design, compatibility considerations, edge cases, and verification plan. Then implement the specification, add appropriate tests, run the relevant checks, commit all intended changes, push the assigned branch, and open a pull request linking the issue with `Closes #{{issue.number}}`.

Before opening the PR, inspect the final diff and ensure no unrelated changes, credentials, build artifacts, or Gerry data files are included. In the PR body, summarize the specification, implementation, and actual verification results.
