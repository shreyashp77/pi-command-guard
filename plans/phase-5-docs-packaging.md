# Phase 5 — Docs & packaging

Status: **✅ complete** (one sub-item intentionally skipped) — depends on Phases 1–4
Depends on: Phases 1–4 (docs must describe final behavior)

## Tasks

- [x] **F — add a LICENSE file** (README claims MIT).
- [x] **F — README accuracy**: rule 14 label ("Dangerous eval/source" vs code's
  "Dangerous export / eval"), rule 3 wording, and the non-interactive behavior
  description.
- [x] **F — refresh AGENTS.md**: line references have drifted (Map at 8 vs actual 13,
  `session_start` at 20 vs 15, `createInputDialog` at 69 vs 73); update architecture
  notes for everything Phases 1–4 changed.
- [~] **A#11 — remove dead code**: unused `ToolCallEvent` import, `_event` param,
  `CONFIG_DIR`, and `saveConfig()` if it stays unwired.
- [~] **F — `.gitignore`**: add entries for any new persistent state/log files.
- [x] **F — CHANGELOG** and version bump policy (currently manual `1.0.2`).
- [x] **F — optional test harness** for `matchCommand` (pure function; the §B false
  positive/negative table is the fixture). Justify explicitly: AGENTS.md says "do not add
  build steps" — a test harness is not a build step, but it is a new dependency, so call
  it out.

### As implemented

- **F — LICENSE added** (`LICENSE`, canonical MIT text) and `"license": "MIT"` in
  `package.json`, so the README's "MIT" claim is backed by a file and by npm metadata.
- **F — README rewritten** to describe actual behaviour: 23 rules with real ids/labels/severities,
  the five-way decision table, argv-aware parsing, the countdown/auto-block rule, the edit flow,
  the three config layers, the settings table, `/guard`, `--no-guard`, a Testing section, and a
  corrected non-interactive description (only rule-matched commands are blocked). The stale items
  called out in the analysis (rule 14 label, rule 3 wording, "blocks by default in print mode") no
  longer exist in the text.
- **F — AGENTS.md refreshed** (full rewrite). Every architecture note that Phases 1–4 invalidated
  was rewritten: session caching now covers blocks and rule-level allows; the non-interactive note
  describes the new placement; first-match-wins is documented with a real example; rule ids are
  stable strings with legacy aliases; the `NEVER_MATCH` failure mode replaces match-everything;
  the `lastIndex` reset is documented as *removed with rationale*; `saveConfig()` is documented as
  wired; the `ExtensionAPI` unresolved-name note is replaced by the actual type-only import; the
  redundant-Promise-wrapper and no-`default`-branch notes are replaced by the current fail-safe
  description. New sections for `commands.ts`, `rules.schema.json`, `tests/`, `plans/`,
  `PI_CODING_AGENT_DIR`, and the `/guard` registration points. **No line-number references remain**
  (they had all drifted); the doc now describes invariants instead of positions.
- **A#11 — dead code removed / consumed**: the unused `type ToolCallEvent` import is gone;
  `CONFIG_DIR` was removed in Phase 2; `saveConfig()` is now called by `/guard`; `MatchResult.matchedText`
  is a real fragment and is consumed by the dialog highlight; `GuardDialogResult.customInstructions`
  was dropped. The only remaining unused parameter is `session_start`'s `_event`, which is positional
  (pi passes `ctx` second) and is documented as such rather than removed.
- **F — `.gitignore` unchanged**: the extension writes no new persistent state or log files at
  runtime (the only writes are the tracked `rules.json` config layers), so there is nothing new to
  ignore. `node_modules/` stays ignored; the verification stubs used during Phases 3–5 were deleted
  after each run.
- **F — CHANGELOG.md added** and `package.json` version bumped `1.0.2` → `1.1.0`. Policy stated
  in the changelog: releases are cut manually, entries describe user-visible behaviour only.
- **F — test harness added**: `tests/matchCommand.test.ts`, run with `node --test`.
  Justification called out explicitly: it installs **no** dependency (Node's built-in test runner +
  `node:assert`), adds **no** build step, and `package.json` still has no `scripts` field — the
  command is documented in README and AGENTS.md instead. The fixture is the §B table from
  `plans/00-analysis.md` plus the Phase 2/4 expectations.

## Verification

```
$ node --test tests/matchCommand.test.ts
✔ matchCommand classifies every table case (2.3ms)      ← 41 command→rule expectations
✔ matchedText is a real fragment, not the whole command
✔ a malformed pattern never matches everything
ℹ pass 3   ℹ fail 0

$ for f in extensions/*.ts tests/*.ts; do node --experimental-strip-types --check "$f"; done
extensions/commands.ts OK   extensions/index.ts OK   extensions/patterns.ts OK
extensions/ui.ts OK         tests/matchCommand.test.ts OK

$ grep -n 'line [0-9]' AGENTS.md README.md      → no matches (no drifted line references)
$ grep -c 'default-'  AGENTS.md README.md       → 2 / 1, both the intentional legacy-alias note
```

`/guard` harness (stub `ctx` + stub pi packages, real `commands.ts`/`ui.ts`/`patterns.ts`):

```
/guard reload   → rules reloaded from disk: 23
/guard list     → all 23 ids with severity + label, in evaluation order
/guard explain "fork-bomb"  → id/label/severity/explanation/pattern
/guard bogus    → help panel (now including the reload line)
```

The harness caught two more quoting bugs, fixed in `commands.ts`: `/guard explain "fork-bomb"`
reported `No rule matches "\"fork-bomb\""` because the id kept its quote characters (`stripQuotes`
applied to the id argument of `explain`/`remove`/`add`/`update`), and `explain` now matches on the
whole quoted phrase so label lookups like `explain "Fork bomb"` work.

The test suite also caught a genuine false positive in the new engine: `cat /etc/hosts` matched
`system-dir-write` because `cat|echo|printf` were in the writer list. Fixed by splitting the rule:
`system-dir-write` keeps real writers (`tee|dd|cp|mv|ln|install`) with an argv path argument, and a
new `redirect-system-dir` regex rule catches `> /etc/...` redirection. Rule count 22 → 23.

## Behaviour changes

- `package.json` version `1.0.2` → `1.1.0`, `license: MIT`; `CHANGELOG.md` and `LICENSE` added.
- New rule `redirect-system-dir`; `system-dir-write` narrowed to real writer commands (removes the
  `cat /etc/hosts` class of false positive).
- `/guard reload` added (subcommand list and autocomplete updated).
- Docs now describe the shipped behaviour; README gained Configuration, `/guard`, Settings and Testing
  sections.

## Result log

- Docs describe invariants rather than line numbers, so they cannot drift the way the previous
  AGENTS.md did; that is the reason the rewrite dropped every `index.ts:NN` reference.
- The test harness is the only new top-level directory (`tests/`); it is not referenced by
  `package.json`, so pi's extension discovery is unaffected.
- Honest gap still open: automatic mtime-based config reload, and the `noUiPolicy`/`cacheBlocks`
  knobs from Phase 4.
