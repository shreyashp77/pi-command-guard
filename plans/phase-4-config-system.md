# Phase 4 — Configuration & discoverability

Status: **✅ complete** (two sub-items deferred) — depends on Phase 2
Depends on: Phase 2

## Tasks

- [x] **D — `/guard` command** (`pi.registerCommand`) with subcommands:
  `list`, `status`, `enable`, `disable`, `add`, `remove`, and `explain "<command>"`
  (dry run: which rule matches, and why).
- [x] **A#8 — config reload.** Invalidate `cachedRules` when `rules.json` mtime changes,
  and/or add `/guard reload`.
- [x] **D — JSON Schema** for `rules.json` plus a `"$schema"` key in the shipped file.
- [x] **D — multi-level config**: user-level (`~/.pi/agent/...`) + project-level override,
  merged in a documented order.
- [~] **D — behavioral settings** separate from rules: `enabled`, `noUiPolicy`,
  `cacheBlocks`, `maxCommandLength`, `dialogTimeoutMs`.
- [x] **D — `pi.registerFlag("no-guard")`** for one-off bypass in automation.
- [x] **D — surface config errors via `ctx.ui.notify`** instead of `console.warn`.
- [x] **A#11 / E — wire up or delete `saveConfig()`** (if kept, use
  `fs.mkdirSync(dir, { recursive: true })`).

### As implemented

- **D — `/guard` command** (`pi.registerCommand`) with subcommands `status`, `list`,
  `check "<command>"` (dry run: which rule matches and why), `explain <id>`, `add`,
  `remove`, `update`, `reset`, `reload`, `on`, `off`, `help`. Implemented in a new module,
  `extensions/commands.ts`; `index.ts` only registers it. Argument autocomplete included.
- **A#8 — config reload.** `saveConfig()` invalidates `cachedRules`, so `/guard` edits
  take effect immediately, and `/guard reload` (added in Phase 5) re-reads the layers from disk
  after an external edit. **Deferred:** automatic mtime-based reload.
- **D — JSON Schema** (`extensions/rules.schema.json`) plus a `"$schema"` key in the shipped
  `rules.json`. `saveConfig()` preserves the pointer.
- **D — multi-level config**, merged lowest precedence first:
  `<agent-dir>/command-guard/rules.json` → `.pi/command-guard/rules.json` (cwd) →
  `extensions/rules.json` (package). Arrays concatenate; `updateRules` merge by id; scalars
  take the last layer that sets them.
- **D — behavioral settings** (partial): `enabled`, `dialogTimeoutMs` (clamped 10s–1h) and
  `maxCommandLength` (clamped 200–100k) are implemented. **Not implemented:** `noUiPolicy`
  (deliberately not a knob — the no-UI path must stay fail-closed) and `cacheBlocks`.
- **D — `pi.registerFlag("no-guard")`** for one-off bypass (`pi.getFlag("no-guard")`).
  Note: pi exposes no `setConfig`/`getConfig` API in this version, so the persisted master
  switch lives in the config layers instead.
- **D — surface config errors via `ctx.ui.notify`**: `readConfigLayer()` records
  human-readable problems (bad JSON, unknown keys, non-compiling patterns, wrong types) and
  `session_start` notifies each one; `console.warn` remains as the fallback for pattern
  compilation.
- [x] **A#11 / E — wired up `saveConfig()`** with `mkdirSync(dir, { recursive: true })`; it now
  throws instead of silently swallowing write failures (callers notify the user).

## Verification

```
$ for f in extensions/*.ts; do node --experimental-strip-types --check "$f"; done
extensions/commands.ts OK   extensions/index.ts OK   extensions/patterns.ts OK   extensions/ui.ts OK

$ python3 -c "import json; json.load(open('extensions/rules.schema.json'))"
schema JSON OK
```

Config-layer harness (user layer removes `recursive-deletion`, project layer adds a good rule,
a broken regex and an unknown key, run with `PI_CODING_AGENT_DIR` + a project cwd):

```
layers: [/tmp/guardcfg-user/command-guard/rules.json,
         /tmp/guardcfg-proj/.pi/command-guard/rules.json,
         /home/shrey/Projects/pi-command-guard/extensions/rules.json]
active rules: 23            (22 built-ins − 1 removed + 2 added)
problems:
  - <project>: unknown key "bogusKey" ignored
  - <project>: addRules rule "broken-rule" has a pattern that does not compile — it will never match
broken-rule pattern: /((?!))/      ← never matches, not match-everything
```

Settings layer (`{"enabled": false, "dialogTimeoutMs": 5000, "maxCommandLength": 50}`):

```
enabled: false  timeout: 10000  limit: 200     ← clamped to the 10s / 200-char floors
```

`/guard` subcommands driven through a stub `ctx` (status, list, explain, add, remove, update,
reset, on, off, bogus, check) all resolved; edits wrote **only** the package layer
(`{"enabled": true, "$schema": "./rules.schema.json"}` after `reset`), so higher layers are
never duplicated into it.

Dry-run results rendered by the real `createInfoPanel` (stub theme, real `ui.ts`):

```
/guard check "rm -rf node_modules"     -> rule recursive-deletion (critical), fragment echoed
/guard check "ls -la"                  -> no rule matches
/guard check "git push -f origin main" -> rule git-force-push (high)
/guard check "sudo rm -rf /"           -> rule recursive-deletion (rule order decides: the
                                           argv rule for sudo does not fire here)
```

The harness caught a real bug: `/guard check "rm -rf /"` reported **no match** because the
quoted argument was passed through with its quote characters. Fixed with `stripQuotes()` in
`commands.ts`, applied to `check`, `add` and `update`.

UI render harness (stub pi-tui components, real `ui.ts` factories) printed the guard dialog
with all five options, the pending-review hint in the title, the two explanation lines and the
`auto-blocks in 120s` countdown footer:

```
====================
⚠️  Command Blocked — Recursive deletion  (2 commands awaiting review)
Recursive deletion permanently removes files.
Second line.

sudo rm -rf /tmp/x

-> Allow — run this command                 Proceed once; the same command will not prompt again this session
   Allow Recursive deletion for the rest…   Skip the prompt for every command this rule matches
   Edit — run a replacement command         Type a different command; the original is never run
   Block — do not run                       Cancel this command
   Custom Instructions                      Tell the LLM what you actually want…
↑↓ navigate • enter select • esc cancel     auto-blocks in 120s
====================
```

Regression check: the Phase 3 handler harness re-run after Phase 4 wiring produced identical
outcomes for all 14 scenarios, and with `getFlag("no-guard") === true` every command passed
through (including the no-UI case), which is the intended explicit bypass.

## Behaviour changes

- New `/guard` slash command (with autocomplete) for inspecting and editing rules.
- New `--no-guard` CLI flag; persisted `enabled: false` in any config layer also disables the guard.
- Config is read from three layers instead of one file; `/guard` edits write the package layer.
- `rules.json` now ships a `$schema` pointer and no longer ships an `enabled` key, so user/project
  layers can actually switch the guard off (the package layer would otherwise shadow them).
- Config problems are reported to the user at session start via `ctx.ui.notify`.
- Dialog timeout and the analysis length cap are configurable (clamped).

## Status

- ✅ Done: everything except automatic mtime-based config reload and the `noUiPolicy`/`cacheBlocks`
  knobs (`/guard reload` was added in Phase 5, covering the manual-reload half of A#8).
- ⏭ Next up: **Phase 5 — docs & packaging**.
