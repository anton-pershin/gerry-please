Triage issue #{{issue.number}}: {{issue.title}}

Requirements supplied by the author:

{{issue.body}}

Assess whether the issue deserves being implemented.

Leave the issue comment with your opinion. If you are satisfied with this issue, apply the `ready-for-human-approval` label with `gh issue edit {{issue.number}} --add-label ready-for-human-approval`. If the issue is not ready, ask the specific questions needed to make it ready or reject the issue completely by applying the `rejected` label.

For a broker-created dependency issue (its body contains `gerry:dependency=`):
- If clarification or changes are needed, ask specific questions with `@implementer`.

Never apply `approved` yourself. The human maintainer will decide whether to apply it manually.
