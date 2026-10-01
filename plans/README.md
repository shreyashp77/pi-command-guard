# Enhancement plan — pi-command-guard

Index for the phased enhancement plan. Each phase has its own doc; status is updated in
the phase doc as work completes, and mirrored in the table below.

| Phase | Scope | Doc | Status |
|---|---|---|---|
| 0 | Analysis (findings, evidence, verified regex behavior) | [`00-analysis.md`](./00-analysis.md) | complete |
| 1 | Fail-safe fixes | [`phase-1-fail-safe-fixes.md`](./phase-1-fail-safe-fixes.md) | **complete** |
| 2 | Detection engine | [`phase-2-detection-engine.md`](./phase-2-detection-engine.md) | **complete** |
| 3 | Guard UX | [`phase-3-guard-ux.md`](./phase-3-guard-ux.md) | **complete** |
| 4 | Config system | [`phase-4-config-system.md`](./phase-4-config-system.md) | **complete** |
| 5 | Docs & packaging | [`phase-5-docs-packaging.md`](./phase-5-docs-packaging.md) | **complete** |

## Ground rules

- One phase at a time; a phase is "complete" only when its verification section passes.
- No phase may introduce a fail-open path: the `tool_call` handler returns only
  `undefined` (run) or `{ block: true, reason }` (cancel).
- The `ctx.hasUI` check stays a security boundary: a rule-matched command must never run
  when the user cannot see the dialog.
- Do not add build steps (project convention). Any new dependency must be justified in the
  phase doc.
