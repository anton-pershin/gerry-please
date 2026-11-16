Discuss dependency issue #{{discussion.issueNumber}} in {{dependency.targetRepository}}: {{discussion.issueTitle}}.

Latest comment from {{discussion.author}}:

{{discussion.body}}

Dependency ID: {{dependency.id}}
Dependency issue: {{discussion.issueUrl}}

You are the implementer who requested this dependency for workflow {{workflow.id}}. Read the dependency requirements and relevant parent-workflow context. Clarify or revise the requirements; do not implement the dependency or resume the parent workflow.

For a clarification that does not change the issue body, send a JSON POST to `$GERRY_DEPENDENCY_URL/comments` with fields `dependencyId` and `body`.

When the issue body needs changes, send a JSON PATCH to `$GERRY_DEPENDENCY_URL/issue` with fields `dependencyId` and `body`. Supply the complete replacement body, not a partial diff.

For both endpoints, include header `Authorization: Bearer $GERRY_AGENT_TOKEN`. Use the dependency ID above. Do not use GH_TOKEN for cross-repository access. Gerry preserves the hidden dependency marker automatically.

The broker rejects comments and edits when `ready-for-human-approval` or `approved` is present. If that happens, stop without retrying or bypassing the gate. Do not apply either label yourself. End your turn after replying or editing.
