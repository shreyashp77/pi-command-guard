# AGENTS.md — pi-command-guard

## Repository structure

**Single-app repository.** This project is a single pi extension package (`pi-command-guard`) that is published as an npm package. There is one root-level AGENTS.md.

---

## What this is

`pi-command-guard` is a [pi](https://pi.dev) extension that intercepts potentially dangerous `bash` tool calls made by the LLM and prompts the user for a decision before the command executes. It ships 23 built-in detection rules with an argv-aware matching engine (segments, wrapper unwrapping, flag-token matching), session-aware caching, a five-way decision dialog, and a layered JSON configuration validated against a bundled JSON Schema. The project is written in TypeScript and depends on `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

---

## Application entry points

This is a pi extension, not a standalone application. The single execution entry point is:

- **`extensions/index.ts`** — The default-exported function registered with pi's extension API (`pi.on("tool_call", ...)`). pi discovers and loads this module when it encounters the extension package. Control flow: pi fires a `tool_call` event → the extension's handler intercepts it → the command is matched against the rule set → if a rule matches, a guard dialog is rendered via the TUI layer → the user's choice is returned to pi, which allows the command, replaces it (edit), blocks it, or injects custom context for the LLM.

Supporting registration points inside the same factory: `pi.registerCommand("guard", …)` (delegates to `extensions/commands.ts`), `pi.registerFlag("no-guard", …)`, `pi.registerMessageRenderer("command-guard", …)`, and `pi.on("session_start", …)`.

No CLI entry points, background workers, scheduled jobs, or other entry points exist.

---

## Commands

The `package.json` defines no `scripts` field. The following commands are therefore **not** provided by the project:

- No build command. pi loads `extensions/index.ts` through jiti, which strips TypeScript types without typechecking them — evidence: `@earendil-works/pi-coding-agent` `dist/core/extensions/loader.js` calls `createJiti(...)` and then `jiti.import(extensionPath, { default: true })`. There is no `tsconfig.json` and no typechecker configured in this repo.
- No lint or format command.
- No publish command.

One command **is** available for verification, added deliberately in Phase 5 (it is not a build step and installs nothing — it uses Node's built-in test runner):

```bash
node --test tests/matchCommand.test.ts
```

Ad-hoc syntax checking without adding tooling: `node --experimental-strip-types --check extensions/<file>.ts`.

`package.json` has no `dependencies` field; the only dependency declarations are `peerDependencies` (`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, both at wildcard `"*"` ranges). The package declares `"pi": { "extensions": ["./extensions"] }`, `"license": "MIT"`, and `"keywords": ["pi-package", ...]`.

Installation is done via pi's install mechanism:

```bash
pi install npm:pi-command-guard
```

Or from GitHub:

```bash
pi install git:github.com/shreyashp77/pi-command-guard
```

Or manual clone into the global extensions directory.

---

## Required runtime environment

- **pi (`@earendil-works/pi-coding-agent`)** — Required. Provides the `tool_call` event system the extension hooks into, `pi.sendMessage()` for injecting context back to the LLM, `ctx.ui.custom()` for the overlay dialogs, `ctx.ui.setStatus()` for the status line, and `DynamicBorder` (used in the dialog borders).
- **pi TUI (`@earendil-works/pi-tui`)** — Required. The guard dialog renders via TUI components (`Container`, `SelectList`, `Text`). Without a TUI, the overlay cannot be displayed.
- **Node.js built-in modules** — `patterns.ts` imports `readFileSync`, `writeFileSync`, `existsSync`, `mkdirSync` from `node:fs`; `dirname`, `join` from `node:path`; `fileURLToPath` from `node:url`. These are Node built-ins, so nothing extra must be installed.
- **Node.js** — Required to execute the TypeScript extension (pi itself provides the runtime).

No databases, Redis, message queues, or external APIs are required. Filesystem writes happen only when `/guard` writes the package config layer (see `saveConfig()` below). No startup ordering beyond pi loading the extension before any `tool_call` fires.

---

## Project structure

```
├── extensions/                        # Extension source code
│   ├── index.ts                       # Main extension entry: registration, session cache, tool_call orchestration
│   ├── patterns.ts                    # Rule definitions (23 built-in), config layers, parsing + matching engine
│   ├── commands.ts                    # /guard subcommands (status, list, check, explain, add, remove, update, reset, reload, on, off, help)
│   ├── ui.ts                          # Guard dialog + input dialog + info panel + transcript message renderer
│   ├── rules.json                     # Package config layer (the shipped template; /guard writes here)
│   └── rules.schema.json              # JSON Schema for all config layers
├── tests/
│   └── matchCommand.test.ts           # Table-driven tests for the detection engine (node --test)
├── plans/                             # Phased enhancement plan + per-phase status/verification logs
├── .gitignore                         # Ignores node_modules/
├── package.json                       # Package metadata, pi extension declaration, peer dependencies
├── LICENSE                            # MIT license text
├── CHANGELOG.md                       # User-visible behaviour per version
└── README.md                          # Installation, usage, rules, configuration, architecture
```

No generated directories, build outputs, or CI configuration files are present.

---

## Architecture notes that aren't obvious from filenames

**Event interception model.** The extension operates through pi's `tool_call` event. It returns `{ block: true, reason: "..." }` to cancel a command, or `undefined` to let it run. The one exception is the edit flow: pi documents `event.input` as mutable, and `index.ts` assigns `event.input.command = trimmed` before returning `undefined`, so a user-typed replacement runs in place of the original.

**Fail-closed invariant.** The handler returns only `undefined` or `{ block: true, reason }`. Every fall-through (cancelled dialog, timeout, empty replacement, unrecognized decision, `switch` `default:` branch) blocks. Never introduce a path that returns `undefined` for a rule-matched command unless the user explicitly allowed it.

**Order inside the `tool_call` handler (current).** `isToolCallEventType("bash", event)` filter → empty/whitespace command filter → `matchCommand(command)` → master switches (`isEnabled()` from config, `pi.getFlag("no-guard")`) → `!ctx.hasUI` block → cache lookups → dialog. Matching happens **before** the `!ctx.hasUI` guard, so in print/JSON mode only rule-matched commands are blocked; unmatched commands run. The `!ctx.hasUI` guard is still the security boundary: a matched command never runs when the user cannot see the dialog.

**Session caching.** Three pieces of per-session state live inside the `pi` factory closure in `index.ts` (not module-global): `allowedCommands: Map<string, number>` and `blockedCommands: Map<string, number>` keyed by `${rule.id}:${command.trim()}`, plus `allowedRules: Set<string>` of rule ids allowed for the whole session. Unlike the original version, **block decisions are cached and read back**: a command the user blocked earlier in the session is silently blocked again, with a reason naming the rule. The numeric value is a hit count surfaced in the status line. All three are cleared by the `session_start` handler, along with the `stats` counters and `pendingDialogs`.

**Status line.** `updateStatus(ctx)` calls `ctx.ui.setStatus("command-guard", …)` — the setter lives on `ExtensionUIContext` (`ctx.ui`), not on `ExtensionContext`. It is called after every decision, including silent cache hits.

**Dialog countdown.** The timeout lives in the UI component (`ui.ts`), not in `ctx.ui.custom`: pi's dialog API has no timeout option. `createGuardDialog` starts a `setInterval` that resolves `{ choice: "block", timedOut: true }` when it expires; the interval is cleared in `finish()` and in `dispose()`. The duration comes from `dialogTimeoutMs()` (config, clamped 10s–1h, default 120s).

**Detection is argv-aware, not regex-only.** `patterns.ts` splits a command into segments on `&&`, `||`, `;`, `|`, newlines; strips comments and quoted string bodies; unwraps wrapper commands (`sudo`, `doas`, `env`, `time`, `nice`, `nohup`, `stdbuf`, `xargs`, `parallel`); skips `NAME=value` assignments; and recurses into `bash -c "…"` bodies. Each rule then matches either on argv (`command` regex + `flagsAllOf`/`flagsAnyOf`/`argAnyOf`) or on a regex over the segment text (`pattern`). Flags are matched as whole tokens, which is why `rm -fr` and `git push -f` are caught without the false positives a `.*` span produced.

**First match wins.** `matchCommand()` iterates rules in order and returns the first match. Rule order therefore decides which label is shown when several rules match (e.g. `sudo rm -rf /` reports `recursive-deletion`, not `privilege-escalation`). The 23 built-in rules are evaluated in array order.

**Rule ids are stable strings.** Built-in ids are written in source (`recursive-deletion`, `git-force-push`, …), so inserting or reordering rules does not move them. Legacy positional ids (`default-0` … `default-13`) are still accepted through `RULE_ID_ALIASES` via `normalizeRuleId()` so old user configs keep working. Custom ids are `custom-23`, `custom-24`, … starting from `defaultRules.length`, unless an entry carries an explicit `id`.

**Severity is informational.** Rules carry `severity: "critical" | "high" | "medium"`, shown in the dialog and reported by `/guard list`. It does not change prompting policy, so it cannot open a fail-open path.

**Negative context.** A rule may carry `except: [regex…]`; if any matches the segment, the rule does not fire. This carves safe cases out of a rule without deleting it.

**Cached rules.** Rules are cached in a module-level `cachedRules`. The cache is invalidated by `saveConfig()` and by `reloadConfig()` (behind `/guard reload`). External edits to `rules.json` therefore need `/guard reload` (or a session start) to take effect.

**Config layers.** Three layers, lowest precedence first: user `<agent-dir>/command-guard/rules.json` (agent dir = `PI_CODING_AGENT_DIR` or `~/.pi/agent`), project `.pi/command-guard/rules.json` under `process.cwd()`, package `rules.json` next to the extension sources (`LOCAL_CONFIG_PATH`, derived from `fileURLToPath(import.meta.url)`). Arrays concatenate; `updateRules` merge by id; scalars take the last layer that sets them. `/guard` writes **only** the package layer via `localConfig()` — writing the merged config back into one layer duplicated higher-layer rules.

**The shipped `rules.json` deliberately omits `enabled`.** If the package layer set `enabled: true`, it would win over the user and project layers and they could never disable the guard. The default is `?? true` in `isEnabled()`.

**Config validation reports, never throws.** `readConfigLayer()` records human-readable problems in `configProblemsFound` (bad JSON, unknown keys, wrong types, rules with neither `pattern` nor `match`, patterns that do not compile). `session_start` notifies each one via `ctx.ui.notify`; `/guard status` and `/guard reload` list them. A failing layer is skipped, so the extension degrades to the remaining layers plus the built-ins.

**Invalid pattern is never-matching, not match-everything.** `stringToRegex()` warns and returns the `NEVER_MATCH` sentinel (`new RegExp("((?!))")`) when a pattern fails to compile. The original code returned `new RegExp("", "g")`, which matched every command. `patternCompiles()` compiles without that fallback so validation can report the problem.

**No stateful regex flags.** All rule regexes are compiled through `stripStatefulFlags()`, which drops `g` and `y`. Because non-global regexes do not carry `lastIndex` state, `matchCommand()` no longer resets `lastIndex` before `test()`. This is strictly safer under pi's documented parallel tool calls than the previous shared-state-plus-reset approach; do not reintroduce `g`/`y` flags on rule patterns without re-adding a reset.

**Analysis cap.** Commands longer than `maxCommandLength()` (config, clamped 200–100000, default 20000) are not analyzed and therefore not flagged. This bounds catastrophic backtracking; it is not a ReDoS guarantee.

**UI composition.** `ui.ts` composes a `Container` with a `DynamicBorder` (imported from `@earendil-works/pi-coding-agent`) while `Container`, `SelectList`, `Text` come from `@earendil-works/pi-tui`. The dialog shows a title (with a "(N commands awaiting review)" hint driven by `pendingDialogs`), the explanation, the command with the matched fragment highlighted in the warning colour, a `SelectList` with five items, help text, and a countdown footer. `ctx.ui.custom` is called with explicit `{ overlay: true, overlayOptions: { anchor: "center", width: 76, maxHeight: 24 } }`; the redundant `new Promise(...)` wrappers of the original version were removed.

**Custom instructions flow.** Selecting "Custom Instructions" opens a separate `createInputDialog()`, then `pi.sendMessage()` with `deliverAs: "followUp"` and `triggerTurn: true` injects a message containing the blocked command, the rule explanation and the user's text. The command stays blocked. `GuardDialogResult` carries only `{ choice, timedOut? }`; the custom text never travels through the select result.

**`commands.ts` has no default export**, so pi's directory scan skips it (`if (typeof factory !== "function") return undefined;`). It is pulled in as a jiti relative import from `index.ts`. Same for `patterns.ts` and `ui.ts`.

**Message rendering.** `pi.registerMessageRenderer("command-guard", createGuardMessageRenderer())` styles the injected guard message in the transcript; without it the custom message renders unstyled.

---

## Environment variables

- **`PI_CODING_AGENT_DIR`** — read in `patterns.ts` (`configLayerPaths()`) to locate the user config layer; falls back to `$HOME/.pi/agent`. `$HOME` is read as a fallback for the same path.
- No other environment variables are read. Everything else is file-based configuration.

---

## Conventions to preserve

**Single-file responsibility.** Each file in `extensions/` has one responsibility: `index.ts` event logic and orchestration, `patterns.ts` rule definitions, config and matching, `ui.ts` rendering, `commands.ts` the `/guard` command surface. Future files should follow this separation.

**Default export pattern.** The extension entry point (`index.ts`) uses a default export function that receives `pi: ExtensionAPI`. Type-only imports come from `@earendil-works/pi-coding-agent` (`import type { ExtensionAPI, ExtensionContext }`), matching pi's own examples.

**Rule ID naming.** Built-in ids are stable strings written in source. Custom ids are `custom-<n>` numbered from `defaultRules.length`. These ids are the key format for `removeRules`/`updateRules`, for `/guard explain`/`remove`/`update`, and for the session cache key.

**Three-way decision enum became five-way.** `GuardChoice = "allow" | "allow-rule" | "edit" | "block" | "custom"` in `ui.ts` is the canonical decision type; `index.ts` switches on it and has a `default:` fail-safe. The `SelectList` `value` strings must match these exactly.

**Regex global flag reset — removed, with rationale.** `matchCommand()` no longer sets `rule.pattern.lastIndex = 0` because every rule regex is compiled without `g`/`y` (see `stripStatefulFlags()`). Keep that invariant if you touch pattern compilation; if a stateful flag ever reappears, the reset must come back.

**Config file path resolution.** The package layer is resolved relative to the extension file using `fileURLToPath(import.meta.url)`, not `process.cwd()`; the project layer is intentionally cwd-relative.

---

## Guidance for future agents

**`extensions/index.ts`.** The most critical file. The `tool_call` handler returns only `undefined` (run) or `{ block: true, reason }` (cancel); every fall-through blocks. The cache key is `${rule.id}:${command.trim()}` — changing the key format without updating all three lookup sites will cause duplicate prompts or missed hits. Keep the master-switch checks (`isEnabled()`, `pi.getFlag("no-guard") === true`) after matching and before the `!ctx.hasUI` guard.

**`extensions/patterns.ts`.** Adding or modifying rules is safe because ids are stable. Rule changes take effect on `getRules()`/`reloadConfig()`; the module-level `cachedRules` means an external config edit needs `/guard reload`. Do not reintroduce `g`/`y` flags on rule regexes (see the `lastIndex` note). Keep `stringToRegex()`'s failure mode never-matching (`NEVER_MATCH`) and keep the warning that names the offending rule.

**`extensions/ui.ts`.** Imports `DynamicBorder` from `@earendil-works/pi-coding-agent` and `Container`, `SelectList`, `Text` from `@earendil-works/pi-tui`. Do not change the `SelectList` item values (`"allow"`, `"allow-rule"`, `"edit"`, `"block"`, `"custom"`) — `index.ts` switches on them. The `done` callback signature is fixed by the pi TUI component contract. The file exports `createGuardDialog()`, `createInputDialog()`, `createInfoPanel()` and `createGuardMessageRenderer()`. Any timer started in a component must be cleared in both `finish()` and `dispose()`.

**`extensions/commands.ts`.** Subcommands are dispatched by a `switch` on the first token; `SUBCOMMANDS` also drives autocomplete, so keep the two in sync. Edits must keep writing only the package layer (`localConfig()`), never the merged config.

**`extensions/rules.json` and `extensions/rules.schema.json`.** Both must remain valid JSON. The package layer must not pin `enabled`. The schema is the documentation surface for all layers; update it when adding a config key.

**`tests/matchCommand.test.ts`.** Table-driven `[command, expectedRuleId]` cases run with `node --test`. Extend the table when changing the engine; do not encode the old regex behaviour as expectations.

**`stringToRegex()`'s failure mode.** It returns `NEVER_MATCH` and warns. Never let it fall back to an empty pattern.

**`matchCommand()` and shared state.** Rule `RegExp` objects live in the module-level `cachedRules` array and are shared across concurrent `tool_call` handlers (pi documents that tool calls from one assistant message can run in parallel). Non-global regexes with no `lastIndex` reads are safe; anything stateful must be per-call.

**Master switches and the security boundary.** `--no-guard` and `enabled: false` are explicit, user-chosen bypasses. Never remove or bypass the `!ctx.hasUI` check for matched commands: it is what prevents a dangerous command from running when the user cannot see the dialog.

**`pi.sendMessage` with `deliverAs: "followUp"`** injects text into the LLM conversation. The message format is interpreted by the LLM, not pi; re-test after changing it.

**Do not add build steps.** The project has no `scripts` in `package.json` and no build tooling. The only verification command is `node --test tests/matchCommand.test.ts`, which uses Node's built-in runner and installs nothing; adding a real test framework or a compile step would need explicit justification.

---

## Deprecated, stale, or unused components

**Nothing in `extensions/` is dead code any more.** The original dead-code items were resolved during the enhancement phases: `saveConfig()` is now called by `/guard` (and creates missing directories via `mkdirSync(dir, { recursive: true })`), `CONFIG_DIR` was removed, the unused `ToolCallEvent` import was removed, `MatchResult.matchedText` is a real fragment consumed by the dialog's highlight, and `GuardDialogResult.customInstructions` was dropped in favour of the separate input dialog.

**`session_start` handler's `_event` parameter is still unused** (`index.ts`); it is positional — `ctx` is the second parameter pi passes — so it cannot be dropped.

**`getRules()` is exported and used** by `index.ts` (session-start warm-up) and `commands.ts`; `reloadConfig()` exists specifically so `/guard reload` can invalidate `cachedRules`.

**`plans/` is a working artifact, not shipped code.** It records the phased enhancement plan and per-phase verification logs; keep it updated when changing behaviour, and do not reference it from `package.json`.

**No lint, format, CI, or release tooling.** Never added; version bumps are manual in `package.json` (currently `1.1.0`) with a matching `CHANGELOG.md` entry.
