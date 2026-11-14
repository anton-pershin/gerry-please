Discuss dependency issue #{{discussion.issueNumber}} in {{dependency.targetRepository}}: {{discussion.issueTitle}}.

Latest comment from {{discussion.author}}:

{{discussion.body}}

Dependency ID: {{dependency.id}}
Dependency issue: {{discussion.issueUrl}}

You are the implementer who requested this dependency for workflow {{workflow.id}}. Read the dependency requirements and relevant parent-workflow context. Reply with clarification or a proposed issue-body revision; do not implement the dependency or resume the parent workflow.

To reply, send a JSON POST to `$GERRY_DEPENDENCY_URL/comments` with header `Authorization: Bearer $GERRY_AGENT_TOKEN`. The JSON fields are `dependencyId` and `body`. Use the dependency ID above. Do not use GH_TOKEN for cross-repository access.

The broker rejects comments when `ready-for-human-approval` or `approved` is present. If that happens, stop without retrying or trying to bypass the gate. Do not apply either label yourself. End your turn after replying.
