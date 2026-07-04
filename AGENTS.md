# AGENTS.md — pi-command-guard

## Repository structure

**Single-app repository.** This project is a single pi extension package (`pi-command-guard`) that is published as an npm package. There is one root-level AGENTS.md.

---

## What this is

`pi-command-guard` is a [pi](https://pi.dev) extension that intercepts potentially dangerous `bash` tool calls made by the LLM and prompts the user for a three-way decision (Allow, Block, or Custom Instructions) before the command executes. It ships 14 built-in detection rules, supports session-aware caching to avoid repeated prompts, and exposes a configurable `rules.json` for adding, removing, or modifying rules. The project is written in TypeScript and depends on `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

---

## Application entry points

This is a pi extension, not a standalone application. The single execution entry point is:

- **`extensions/index.ts`** — The default-exported function registered with pi's extension API (`pi.on("tool_call", ...)`). pi discovers and loads this module when it encounters the extension package. Control flow: pi fires a `tool_call` event → the extension's handler intercepts it → if the command matches a dangerous pattern, a guard dialog is rendered via the TUI layer → the user's choice is returned to pi, which either allows the command to run, blocks it, or injects custom context for the LLM.

No CLI entry points, background workers, scheduled jobs, or other entry points exist.

---

## Commands

The `package.json` defines no `scripts` field. The following commands are therefore **not** provided by the project:

- No build command (TypeScript is not compiled; pi loads `.ts` files directly or expects the package to be pre-built by the consumer).
- No lint or format command.
- No test command.
- No publish command.

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

- **pi (`@earendil-works/pi-coding-agent`)** — Required. Provides the `tool_call` event system the extension hooks into, `pi.sendMessage()` for injecting context back to the LLM, and `DynamicBorder` (used in the dialog borders). Without pi, the extension has nothing to attach to.
- **pi TUI (`@earendil-works/pi-tui`)** — Required. The guard dialog renders via TUI components (`Container`, `SelectList`, `Text`). Without a TUI, the overlay cannot be displayed.
- **Node.js** — Required to execute the TypeScript extension (pi itself provides the runtime).

No databases, Redis, message queues, or external APIs are required.

---

## Project structure

```
├── extensions/                        # Extension source code
│   ├── index.ts                       # Main extension entry: event handler, session cache, dialog orchestration
│   ├── patterns.ts                    # Rule definitions (14 built-in), config loading, regex matching logic
│   ├── rules.json                     # User-editable config: addRules, removeRules, updateRules (all empty by default)
│   └── ui.ts                          # Guard dialog UI: renders overlay with command, explanation, and 3-option select list
├── .gitignore                         # Ignores node_modules/
├── package.json                       # Package metadata, pi extension declaration, peer dependencies
└── README.md                          # Installation, usage, and architecture documentation
```

No generated directories, build outputs, or CI configuration files are present.

---

## Architecture notes that aren't obvious from filenames

**Event interception model.** The extension operates entirely through pi's `tool_call` event. It does not modify the command before execution; instead, it returns `{ block: true, reason: "..." }` to cancel the command, or returns nothing (undefined) to let it pass through. The `{ block: true }` mechanism is the only way to prevent a command from running.

**Session caching.** A `Map<string, DecisionEntry>` tracks per-session allow/block decisions keyed by `${rule.id}:${command.trim()}`. When a user allows a command, it is cached with `count: 1`. On subsequent matches of the same rule+command, the count increments and the command is allowed silently without prompting. The cache is cleared on `session_start`. This means the cache is ephemeral — it does not persist across pi restarts or session changes.

**Non-interactive safety default.** When `ctx.hasUI` is false (e.g., in a headless or JSON-output mode), the extension blocks all dangerous commands by default with the reason `"Command guard: blocked (no UI for confirmation)"`. This is a security-first design decision: if the user cannot see the dialog, the command is denied.

**Custom instructions flow.** When the user selects "Custom Instructions," the extension shows an input dialog, then calls `pi.sendMessage()` with `deliverAs: "followUp"` and `triggerTurn: true`. This injects a formatted message into the LLM conversation that includes the blocked command, the rule explanation, and the user's custom text. The original command is still blocked. The LLM then receives this as a follow-up turn and can suggest a safer alternative.

**Regex matching is first-match-wins.** `matchCommand()` iterates rules in order and returns the first match. The order of the 14 built-in rules matters: for example, a command matching both "Remote code execution via pipe" and "Dangerous eval/source" would only trigger the former since it appears first in the array.

**Config file location.** `rules.json` is resolved relative to the extension file's directory using `fileURLToPath(import.meta.url)`, which means it works both when the extension is installed locally (cloned) and when installed as an npm package (assuming the `.json` is bundled alongside the `.ts`).

**Cached rules.** Rules are cached in a module-level `cachedRules` variable. The cache is invalidated only when `saveConfig()` is called (which writes to disk and resets the cache). No other mechanism invalidates it. If `rules.json` is edited externally without calling `saveConfig()`, the changes will not take effect until the extension is reloaded.

**Pattern format flexibility.** The `stringToRegex()` helper accepts both raw regex strings (`"\\brm\\s+-rf\\b"`) and regex literals (`"/\\brm\\s+-rf\\b/g"`). This is used when loading user-defined patterns from `rules.json`.

**Dialog is a Promise-based wrapper.** `showGuardDialog()` wraps `ctx.ui.custom()` in a Promise. The TUI component system uses a callback-based API (`done: (result) => void`), and this wrapper converts it to an async/await pattern for the event handler.

**UI component composition.** The guard dialog (`ui.ts`) composes a `Container` with a `DynamicBorder` (styled with `theme.fg("warning", ...)`) — note that `DynamicBorder` is imported from `@earendil-works/pi-coding-agent`, while `Container`, `SelectList`, `Text`, and `SelectItem` come from `@earendil-works/pi-tui`. The dialog includes a title `Text`, explanation `Text` lines, a command display `Text`, a `SelectList` with three items, a help-text `Text`, and a bottom `DynamicBorder`. The `SelectList` is configured with theme-aware styling for selected prefix, selected text, description, scroll info, and no-match states.

**No input validation on custom instructions.** The custom instructions text is passed directly to the LLM via `pi.sendMessage()` without sanitization or length limits. This is acceptable since it is user-provided text being forwarded to the LLM, not executed as code.

**Error handling in config loading.** If `rules.json` fails to parse, `loadConfig()` logs a warning and returns an empty config `{}`. The extension degrades gracefully to using only the 14 built-in rules. If `saveConfig()` fails, it logs a warning and does not throw.

---

## Environment variables

Not applicable — no environment variables are read at runtime. Configuration is entirely file-based via `rules.json`.

---

## Conventions to preserve

**Single-file responsibility.** Each file in `extensions/` has a single, well-defined responsibility: `index.ts` handles event logic and orchestration, `patterns.ts` handles rule definitions and matching, `ui.ts` handles dialog rendering. Future files should follow this separation.

**Default export pattern.** The extension entry point (`index.ts`) uses a default export function that receives `pi: ExtensionAPI`. This is the pi extension convention.

**Rule ID naming.** Default rules use `default-0` through `default-13`. Custom rules use `custom-N` where N is the next available index after defaults. This naming is consumed by `rules.json`'s `removeRules` and `updateRules` arrays and by the session cache key.

**Regex global flag reset.** In `matchCommand()`, `rule.pattern.lastIndex = 0` is explicitly set before each `test()` call. This is necessary because global regexes retain `lastIndex` between calls, which would cause subsequent tests to fail or match incorrectly.

**Config file path resolution.** The config path is resolved relative to the extension file using `fileURLToPath(import.meta.url)`, not relative to `process.cwd()`. This ensures the config works regardless of where pi is invoked from.

**Three-way decision enum.** The `GuardChoice` type (`"allow" | "block" | "custom"`) is the canonical decision type. Both `index.ts` and `ui.ts` reference it, and the `SelectList` values must match these strings exactly.

---

## Guidance for future agents

**`extensions/index.ts`.** This is the most critical file — it orchestrates the entire extension. Modifying the `tool_call` handler requires understanding the return value semantics: `undefined` = let command run, `{ block: true, reason }` = cancel command. Do not return other shapes. The session cache (`sessionDecisions` Map) is keyed by `${rule.id}:${command.trim()}` — changing this key format without also updating the cache check will cause duplicate prompts or missed cache hits.

**`extensions/patterns.ts`.** Adding or modifying rules is safe as long as rule IDs are preserved for existing rules (or updated in `rules.json`). The `cachedRules` module-level variable means rule changes only take effect on extension reload. Do not remove the `lastIndex = 0` reset in `matchCommand()` — it is required for correct global regex behavior.

**`extensions/ui.ts`.** The dialog component imports `DynamicBorder` from `@earendil-works/pi-coding-agent` and `Container`, `SelectList`, `Text`, `SelectItem` from `@earendil-works/pi-tui`. Do not change the `SelectList` item values (`"allow"`, `"block"`, `"custom"`) — they are matched against the `GuardChoice` type in `index.ts`. The `done` callback signature is fixed by the pi TUI component contract. The file also exports `createInputDialog()` which renders a simple text input dialog for the "Custom Instructions" flow.

**`extensions/rules.json`.** This file is user-editable and should remain valid JSON. The three arrays (`addRules`, `removeRules`, `updateRules`) are all optional and default to empty. Adding rules here does not require code changes.

**Rule order matters.** The 14 built-in rules are evaluated in array order. If a new rule is added that overlaps with an existing one, the first match wins. Document any new rule's priority relationship to existing rules.

**The `ctx.hasUI` guard is a security boundary.** Never remove or bypass the `!ctx.hasUI` check. It is the fallback that prevents dangerous commands from running when the user cannot see the dialog.

**`pi.sendMessage` with `deliverAs: "followUp"`** injects text into the LLM conversation. The format of this message is parsed by the LLM, not by pi. Changing the message format should be tested to ensure the LLM still interprets it correctly.

**Do not add build steps.** The project has no `scripts` in `package.json` and no build tooling. If TypeScript compilation is needed in the future, it should be added deliberately with clear justification.

---

## Deprecated, stale, or unused components

**`saveConfig()` in `patterns.ts` is incomplete.** The function writes to `CONFIG_PATH` but contains a dead-code branch (`if (!existsSync(dir))`) that does nothing. It should call `fs.mkdirSync(dir, { recursive: true })` if the directory does not exist, but currently does not. This function appears unused anywhere in the codebase — no caller invokes `saveConfig()`. It may be intended for future use (e.g., a config editor UI), but is currently dead code.

**`readFileSync` and `writeFileSync` are imported in `patterns.ts`** but `writeFileSync` is only used in the incomplete `saveConfig()`. If `saveConfig()` is removed, `writeFileSync` becomes unused.

**`rules.json` has all empty arrays.** The default config file ships with `addRules: [], removeRules: [], updateRules: []`. This is intentional and not stale — it serves as the template for user customization.

**No tests, linting, or CI.** The project has no test framework, no lint configuration, no CI workflow files, and no build pipeline. This is not deprecated — it was never added.
