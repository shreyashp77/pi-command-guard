# Changelog

Version numbers follow `package.json`. Releases are cut manually; there is no
release tooling. Entries describe user-visible behaviour.

## 1.1.0

Detection:

- Rules are now argv-aware: commands are split into segments (`&&`, `||`, `;`,
  `|`, newlines), quoted strings and comments are stripped, and wrapper commands
  (`sudo`, `env`, `time`, `nice`, `nohup`, `stdbuf`, `xargs`, `parallel`) are
  unwrapped before matching. Flags are matched as whole argv tokens.
- Built-in rules grew from 14 to 23, adding `git push -f`, `git clean -fdx`,
  `git checkout --`, `find … -delete`, `kill -9`, `> /dev/sd*`, fork bombs,
  `shutdown`/`reboot`, `history -c`, `redirect-system-dir`, and others.
- Rules carry stable string ids (`recursive-deletion`, …); legacy `default-N`
  ids are still accepted as aliases.
- Rules declare `severity` (`critical`/`high`/`medium`), shown in the dialog and
  by `/guard list`. It does not change prompting policy yet.
- A malformed pattern is reported and disabled (never matches) instead of
  compiling to an empty regex that matches everything.
- `matchedText` now reports the flagged fragment rather than the whole command.

Guard UX:

- The dialog offers five decisions: allow this command, allow the rule for the
  session, edit the command, block, custom instructions.
- `edit` re-checks the replacement command; it runs only if no rule matches.
- Blocked decisions are cached for the session (previously only allows were).
- The dialog counts down (120s default) and auto-blocks if unanswered; `esc`
  blocks.
- The flagged fragment is highlighted; the status line tallies prompts, allows
  and blocks; guard messages render with a registered message renderer.

Configuration:

- New `/guard` command: `status`, `list`, `check`, `explain`, `add`, `remove`,
  `update`, `reset`, `reload`, `on`, `off`, `help`.
- Config is read from three layers (user → project → package); `/guard` writes
  only the package layer.
- New `rules.schema.json` and a `"$schema"` pointer in `rules.json`; config
  problems are reported at session start.
- Settings `enabled`, `dialogTimeoutMs`, `maxCommandLength` are configurable and
  clamped.
- New `--no-guard` flag disables the guard for a single pi run.
- Non-interactive runs now block only commands that match a rule (previously
  every non-empty `bash` command was blocked).

## 1.0.2

- Fixed the custom-instructions dialog not appearing.

## ≤ 1.0.1

- Initial extension: 14 regex rules, three-way Allow/Block/Custom decision,
  allow-only session cache, single `rules.json`.
