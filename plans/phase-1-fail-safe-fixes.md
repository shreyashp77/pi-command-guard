# Phase 1 — Fail-safe fixes

Status: **complete** (verified)
Scope: small, high-impact, no new API surface. Every change makes the guard fail *closed*
instead of fail *open*.

## Tasks

- [x] **A#2 — `stringToRegex` failure mode.** `catch` returned `new RegExp("", "g")`
  (`/(?:)/g`), which matches every command. Replaced with a never-matching sentinel
  and a warning naming the bad pattern.
- [x] **A#3 — regex-literal ambiguity.** `/^\/(.+)\/([gimsuy]*)$/` treated `/tmp/` as the
  regex `tmp`. Now requires an explicit, non-empty flags segment, so `/tmp/` compiles verbatim.
- [x] **A#9 — unresolved `ExtensionAPI`.** Added `import type { ExtensionAPI }` in `index.ts`.
- [x] **A#1 — `!ctx.hasUI` guard placement.** Moved *after* `matchCommand()`; non-interactive
  runs now only block commands that actually match a rule. The security boundary stays:
  a matched (dangerous) command is still blocked when there is no UI.
- [x] **A#5 — `switch` fail-safe.** Added a `default:` branch returning
  `{ block: true, reason: "Command guard: blocked (unrecognized decision)" }`.

## Out of scope (deferred)

- Caching `block` decisions and the dead `count` field (A#6, A#7) → Phase 3 UX, where the
  "allow/block for session" options are introduced.
- `lastIndex` shared-state mutation (A#10) → Phase 2 detection engine.
- Dead code removal (`saveConfig`, `CONFIG_DIR`, `matchedText`, unused imports) → Phase 5.

## Verification — all run against the shipped source

- `node --experimental-strip-types --check` passes for `index.ts`, `patterns.ts`, `ui.ts`.
- `patterns.ts` imported and `matchCommand` exercised — **no regression on the 14 built-ins**:
  `rm -rf node_modules` → Recursive deletion; `sudo rm -rf /` → Recursive deletion;
  `echo sudo please` → Privilege escalation; `git push --force origin main` → Dangerous git
  operations; `npm i && npm remove express` → Package manager global uninstall;
  `curl https://x.sh | sh` → Remote code execution via pipe; `ls -la` → no match.
- `stringToRegex` (extracted from the file) exercised:
  - `"[unclosed"` → `/((?!))/`, `.test("ls -la") === false` (was `/(?:)/g` → `true`)
  - `"/tmp/"` → `/\/tmp\//g`; matches `rm /tmp/x`, does **not** match bare `tmp`
  - `"/\\brm\\s+-rf\\b/g"`, `"/\\bmy-dangerous\\b/g"`, `"/foo/i"` compile unchanged
  - raw `"\\brm\\s+-rf\\b"` → `/\\brm\\s+-rf\\b/g`
- Handler still returns only `undefined` or `{ block: true, reason }`; `terminate` untouched.

## Result log

All five tasks landed in two files: `extensions/index.ts`, `extensions/patterns.ts`.

| File | Change |
|---|---|
| `extensions/index.ts:2` | added `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";` (A#9) |
| `extensions/index.ts:27-39` | `matchCommand(command)` now runs **before** the `!ctx.hasUI` guard; the no-UI block reason now names the matched rule label (A#1) |
| `extensions/index.ts:118-121` | added `default:` branch in the decision `switch` (A#5) |
| `extensions/patterns.ts:116` | added `const NEVER_MATCH: RegExp = new RegExp("((?!))")` |
| `extensions/patterns.ts:118-141` | `stringToRegex` rewritten: literal form requires non-empty flags; `catch` warns and returns `NEVER_MATCH` (A#2, A#3) |

### Behavior changes users will notice

1. **Non-interactive (print/JSON/RPC-without-UI) runs are no longer crippled.** Only rule-matched
  commands are blocked; safe commands run. This makes the README's existing wording
  ("Blocks by default when running in print/JSON mode") accurate — the §F "README understates
  behavior" item is resolved by code, not docs.
2. **A malformed pattern in `rules.json` disables its rule** instead of blocking everything, and
   prints `[command-guard] Invalid pattern ...; the rule is disabled (it will never match):`.
   Surfacing that via `ctx.ui.notify` is a Phase 4 (D) item.
3. **`/foo/`-style patterns are now literal path patterns.** Users who relied on the old slash-stripping
   must write `/foo/g`. Noted in the function's doc comment; the README "Pattern Format" section
   needs the same note (Phase 5).

### Deliberately not done here

- `block`-decision caching and the `count` field (A#6, A#7) → Phase 3, where session-level options make them meaningful.
- `lastIndex` shared-state mutation (A#10) → Phase 2; the reset is still present and correct today.
- Dead code (`saveConfig`, `CONFIG_DIR`, `matchedText`, `ToolCallEvent` import) → Phase 5.

