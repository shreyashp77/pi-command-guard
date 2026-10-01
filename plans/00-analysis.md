# 00 — Enhancement analysis (pi-command-guard)

Status: **complete** (analysis only, no code changed to produce this doc)
Date: analysis of `main` @ `a9b7cae` (v1.0.2)

Findings are grounded in the code. Regex claims were verified by running the actual
patterns in Node.

---

## A. Latent defects (bugs, not nice-to-haves)

| # | Issue | Evidence | Impact |
|---|---|---|---|
| 1 | **Non-interactive mode blocks *all* bash, not just dangerous bash** | `index.ts:27` `if (!ctx.hasUI) return {block:true}` runs **before** `matchCommand(command)` (line 31) | `pi -p` / JSON / RPC-without-UI runs are crippled: every non-empty `bash` call is denied. README wording ("blocks by default in print/JSON mode") understates this. |
| 2 | **Bad pattern becomes a match-everything rule** | `patterns.ts:117` catch returns `new RegExp("", "g")`. Verified: `stringToRegex("[unclosed")` → `/(?:)/g`, `.test("ls -la") === true` | One typo in user-edited `rules.json` silently blocks **every** command. Sharpest edge in the repo. |
| 3 | **Regex-literal parsing is ambiguous** | Verified: `stringToRegex("/tmp/")` → `/tmp/` (slashes stripped, matches `tmp` anywhere) | Any raw pattern that both starts and ends with `/` loses its slashes. |
| 4 | **Rule IDs are positional** | `patterns.ts:196` `default-${i}` | Inserting/reordering a default rule silently retargets user `removeRules`/`updateRules`. |
| 5 | **`switch (result.choice)` has no `default`** | `index.ts:50` | Unknown `SelectList` value falls through → returns `undefined` → **command runs**. Fail-open. |
| 6 | **`block` decisions are written but never read** | cache read at `index.ts:36` only accepts `decision === "allow"` | Blocking a command re-prompts forever. |
| 7 | **`count` is dead weight** | only tested `> 0`; incremented but otherwise unused | Drop it or make it meaningful. |
| 8 | **`cachedRules` never invalidated on external edit** | only `saveConfig()` resets it, and `saveConfig` is never called | Editing `rules.json` requires a full `/reload`. |
| 9 | **`ExtensionAPI` is an unresolved name** | `index.ts:5` annotates `pi: ExtensionAPI`; only import is `{ isToolCallEventType, type ToolCallEvent }` | Works only because jiti strips types. Any future typechecker fails here. |
| 10 | **Shared mutable regex state** | `matchCommand` sets `rule.pattern.lastIndex = 0` on objects in the module-level `cachedRules` array; pi documents that tool calls from one assistant message run **in parallel** | Concurrent handlers mutate the same `RegExp` objects. |
| 11 | Dead code / unused symbols | `saveConfig()` (never called, empty `if (!existsSync(dir))` branch), `CONFIG_DIR` (`patterns.ts:132`), `matchedText` (whole command, never read), `ToolCallEvent` import, `_event` param | Cleanup or wire-up. |

---

## B. Detection quality — verified false positives / negatives

Ran the real patterns:

```
"rm -fr node_modules"              -> (no match)   <- false negative
"git push -f"                      -> (no match)   <- false negative (most common form!)
"git push origin --force"          -> (no match)
"find . -name tmp -delete"         -> (no match)
"rm -rf -- /"                      -> rm           (ok)
"echo \"rm -rf /\""                -> rm           <- false positive
"echo sudo please"                 -> sudo         <- false positive
"npm remove-node-modules"          -> pkg          <- false positive (the .* span)
"npm i && npm remove express"      -> pkg          (true positive)
```

Root cause: `.*` spans between two tokens and flag-order assumptions.

Improvements:
- **Segment/token-aware matching** — split on `&&`, `;`, `|`, `||`, newlines; match per segment; match flags as real argv tokens instead of `.*` spans.
- **Strip comments and quoted strings** before matching (kills the `echo "rm -rf /"` class).
- **Severity tiers** — `sudo` alone is noisy vs `rm -rf /`. Today everything prompts identically.
- **Missing rules**: `git push -f`, `git clean -fdx`, `git checkout -- .`, `find … -delete`, `xargs rm`, `rm --force`, `dd of=/dev/*`, `> /dev/sd*`, fork bombs, `killall`/`pkill -9`, `shutdown`/`reboot`, `history -c`, `chmod -R`.
- **Per-rule `exceptPatterns`** (negative context) so users can carve out safe cases without deleting a whole rule.

---

## C. UX / interaction enhancements

- **4th option: "Allow this rule for the rest of the session"** — cache is keyed on the exact command, so `rm -rf a` then `rm -rf b` prompts twice.
- **"Edit the command instead"** — pi documents `event.input` as mutable; letting the user type a corrected command and mutating it in place is currently impossible. High value.
- **Highlight the matched fragment** in the dialog (needs the `matchedText` fix from A#11).
- **Status line / widget** via `ctx.setStatus` / `setWidget` — "guard: 2 blocked, 5 allowed this session".
- **Message renderer** — `pi.sendMessage({customType: "command-guard", …})` (`index.ts:80`) has no `registerMessageRenderer("command-guard", …)`, so it renders with default styling.
- **Batched review** — parallel tool calls produce stacked dialogs; one "3 commands need review" dialog is calmer.
- **Pass `overlayOptions` explicitly** — both `ctx.ui.custom(...)` call sites pass no options, so positioning is entirely default.
- **Timed auto-block** for unattended sessions (pi ships a `timed-confirm.ts` example) so a hung terminal cannot wait forever.
- **Redundant Promise wrappers** — `new Promise(...)` around `ctx.ui.custom(...)` (`index.ts:128`, `:73`); `ctx.ui.custom<T>` already returns `Promise<T>`.

---

## D. Configuration & discoverability

- **`/guard` command** (`pi.registerCommand`) with `list`, `status`, `enable/disable`, `add`, `remove`, and especially **`explain "<command>"`** — a dry run showing which rule matches. Biggest missing debugging affordance for a regex-based guard.
- **JSON Schema** for `rules.json` (`"$schema"` key) so editors validate as you type.
- **Multi-level config** — `CONFIG_PATH` is only next to the extension file (`patterns.ts:135`); consider user-level + project-level override.
- **Behavioral settings separate from rules**: `enabled`, `noUiPolicy`, `cacheBlocks`, `maxCommandLength`, `dialogTimeoutMs`.
- **`pi.registerFlag("no-guard")`** for one-off bypass in automation.
- **Report config errors via `ctx.ui.notify`**, not `console.warn` (`patterns.ts:181`) — warnings are invisible in the TUI.

---

## E. Robustness

- **Validate user patterns at load**: compile + probe-test, report failures, drop the rule instead of letting it become match-everything.
- **Cap command length** before regex matching (pathological model output).
- **ReDoS guard** for user-supplied patterns — built-ins are linear (timed one: 0ms on a 200k-char string), but `rules.json` patterns are unbounded.
- **`try/catch` around `matchCommand`** — a handler failure blocks the tool as a fail-safe, but currently the user loses the explanation.
- **`session_shutdown` idempotent cleanup handler** — recommended by pi docs; not present.
- **`powershell` tool calls are not covered** — only `isToolCallEventType("bash", …)`. Windows users get no protection.
- **`dispose()` on custom components** — allowed by the component contract; neither dialog provides it.

---

## F. Repo / docs hygiene

- **No LICENSE file** despite README claiming MIT.
- **README vs code drift**: README rule 14 is "Dangerous eval/source", code label is `"Dangerous export / eval"`; README rule 3 wording ("`chown` with same") is garbled; README's non-interactive description is weaker than actual behavior.
- **AGENTS.md line references have drifted**: cites the Map at line 8 (actual 13), `session_start` at 20 (actual 15), `createInputDialog` at 69 (actual 73). `hasUI`/`matchCommand`/`switch` still match.
- **`.gitignore` is minimal** (`node_modules/` only) — needs entries if persistent decision/config state is added.
- **No tests** — `matchCommand` is a pure function and trivially testable; the false negatives in §B are exactly what a table-driven test would catch. (AGENTS.md says "do not add build steps"; a test harness is a deliberate, justified addition, not a build step.)

---

## Phase plan

| Phase | Scope | Doc |
|---|---|---|
| 1 | Fail-safe fixes (A#2, A#3, A#5, A#9, A#1 guard placement) | `phase-1-fail-safe-fixes.md` |
| 2 | Detection engine (stable IDs, segment-aware matching, severity, new rules, pattern validation, shared-state fix) | `phase-2-detection-engine.md` |
| 3 | Guard UX (session-level allow, edit-the-command, matched fragment, status line, message renderer, timed auto-block) | `phase-3-guard-ux.md` |
| 4 | Config system (`/guard` command + `explain`, JSON schema, multi-level config, settings, CLI flag) | `phase-4-config-system.md` |
| 5 | Docs & packaging (LICENSE, README/AGENTS refresh, optional test harness) | `phase-5-docs-packaging.md` |
