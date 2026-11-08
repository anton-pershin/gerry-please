# Gerry, Please

## Project conventions

- Runtime: Bun and strict TypeScript. Use `bun run check` before finishing changes.
- The orchestrator is runtime-neutral. OpenCode- and Hermes-specific code belongs only in `src/runtimes/`.
- GitHub is the collaboration source of truth; SQLite is the operational source of truth.
- Workflow IDs are unique per origin issue; workflow types are not singletons. Serialize turns only within an instance.
- Preserve implementer session/worktree identity across the origin issue and PR through the recorded head branch.
- Dependencies require an explicit repository policy and timeline-verified closure through a default-branch PR merge before resolution. Resume idempotency is scoped by workflow and dependency cycle.
- Cross-repository actions belong in the capability-checked daemon broker, never in agent-held broad credentials.
- Never log webhook signatures, private keys, GitHub installation tokens, agent capabilities, or runtime credentials.
- Acknowledge a webhook only after its payload is durably stored.
- Agent side effects are not exactly-once. Preserve run lineage and make retries explicit where ambiguity is possible.
- Keep configuration declarative; do not add executable JavaScript rule conditions.
- Human-facing observability belongs in JSONL and per-run files. Do not add a GUI.
