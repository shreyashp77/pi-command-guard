# pi-command-guard

A global [pi](https://pi.dev) extension that intercepts potentially dangerous bash commands and prompts the user for confirmation before execution.

## Features

- **Intercepts dangerous commands** — 23 built-in rules covering risky shell operations, checked before the command runs
- **Argument-aware detection** — commands are parsed into segments and argv tokens, so `git push -f`, `rm -fr`, `find … -delete` and `xargs rm -rf` are caught while `echo "rm -rf /"` is not
- **Five-way decision** — Allow once, allow a whole rule for the session, edit the command, block, or give Custom Instructions to the LLM
- **Session-aware caching** — allowed commands and blocked commands are remembered per session, so the same command does not prompt again
- **Non-interactive safety** — when no UI is available, any command that matches a rule is blocked rather than run
- **Styled overlay dialog** — the flagged fragment is highlighted, with the rule label, severity and explanation
- **Status line** — prompts, allows and blocks are tallied in pi's status line
- **Configurable rules** — add, remove or modify rules through layered JSON config files, validated against a bundled JSON Schema
- **`/guard` command** — inspect rules, dry-run a command against the ruleset, and edit config from the chat
- **`--no-guard` flag** — disable the guard for a single pi run

## Installation

### Quick install (recommended)

```bash
pi install npm:pi-command-guard
```

Then restart pi or run `/reload`.

### Install from GitHub

```bash
pi install git:github.com/shreyashp77/pi-command-guard
```

Then restart pi or run `/reload`.

### Manual install

Clone the repo into your global extensions directory:

```bash
git clone git@github.com:shreyashp77/pi-command-guard.git ~/.pi/agent/extensions/command-guard
```

Then restart pi or run `/reload`.

### Verify installation

Start pi and run a command you expect to be flagged (for example, ask the agent to run `rm -rf /tmp/some-scratch-dir`). The guard dialog should appear. You can also run `/guard status` — it should report the guard as enabled.

## How It Works

When the LLM calls the `bash` tool, the extension checks the command before it runs:

1. **Parse** — the command string is split into segments on `&&`, `||`, `;`, `|` and newlines; quoted strings and comments are stripped; wrapper commands (`sudo`, `env`, `time`, `nice`, `nohup`, `stdbuf`, `xargs`, `parallel`) are unwrapped so the real command is inspected
2. **Match** — each rule matches either on argv tokens (`command` + `flagsAllOf`/`flagsAnyOf`/`argAnyOf`) or on a regex over the segment text; the first matching rule wins, in rule order
3. **Dialog** — a styled overlay shows the command with the flagged fragment highlighted, the rule label, severity and explanation
4. **Decision** — choose one of five options:

| Option | What happens |
|--------|-------------|
| **Allow — run this command** | The command runs. The exact command is cached for the rest of the session. |
| **Allow this rule for the session** | Every command that matches this rule stops prompting for the rest of the session. |
| **Edit — run a replacement** | You type a different command. The original is never run; the replacement is re-checked against the rules and only runs if it is clean. |
| **Block — do not run** | The command is cancelled. The decision is cached, so the same command is silently blocked for the rest of the session. |
| **Custom Instructions** | You describe what you actually want. The command stays blocked and the LLM receives the blocked command, the rule explanation and your instructions as a follow-up turn. |

If you do not answer, the dialog counts down (120 seconds by default) and the command is **blocked** automatically. Cancelling the dialog with `esc` also blocks.

### Non-interactive runs

When pi has no UI (`print`/JSON mode), a command that matches a rule is blocked with a reason naming the rule. Commands that match no rule run normally. Pass `--no-guard` to skip the guard entirely for a run — that is the explicit, deliberate bypass.

## Built-in Rules

Rules are evaluated in this order; the first match wins.

| # | Rule id | Severity | What it catches |
|---|---------|----------|-----------------|
| 1 | `recursive-deletion` | critical | `rm` with `-r`, `-rf`, `-fr`, `--recursive`, `--no-preserve-root` |
| 2 | `privilege-escalation` | critical | `sudo`, `doas` |
| 3 | `permissive-permissions` | high | `chmod`/`chown` with modes like `777`, `667` |
| 4 | `disk-device-operations` | critical | `dd` |
| 5 | `filesystem-creation` | critical | `mkfs`, `mkfs.ext4`, … |
| 6 | `remote-exec-pipe` | critical | `curl … \| bash`, `wget … \| sh`, `curl … \| sudo sh` |
| 7 | `netcat-exec` | critical | `nc -e`, `ncat -c` |
| 8 | `system-dir-write` | high | `tee`, `dd`, `cp`, `mv`, `ln`, `install` writing into `/etc/`, `/boot/`, `/bin/`, `/usr/sbin/`, `/lib/`, `/sys/`, … |
| 9 | `redirect-system-dir` | high | `> /etc/…`, `>> /usr/bin/…` output redirection into system directories |
| 10 | `package-uninstall` | medium | `npm uninstall`, `pip remove`, `apt purge`, `brew autoremove`, … |
| 11 | `git-force-push` | high | `git push -f`, `--force`, `--force-with-lease` |
| 12 | `git-reset-hard` | high | `git reset --hard` |
| 13 | `git-discard-checkout` | high | `git checkout -- <path>` |
| 14 | `git-clean-force` | high | `git clean -f`, `-fd`, `-fdx` |
| 15 | `truncate-empty` | high | `truncate -s 0 <file>` |
| 16 | `kill-sigkill` | high | `kill -9`, `killall -KILL`, `pkill -SIGKILL` |
| 17 | `mkswap` | critical | `mkswap` |
| 18 | `eval-remote` | critical | `eval`/`source` combined with `curl`/`wget` |
| 19 | `find-delete` | high | `find … -delete` |
| 20 | `block-device-redirect` | critical | `> /dev/sda`, `/dev/nvme0n1`, … |
| 21 | `fork-bomb` | critical | `:(){ :\|:& };:` |
| 22 | `shutdown-system` | high | `shutdown`, `reboot`, `halt`, `poweroff`, `init` |
| 23 | `history-clear` | medium | `history -c` |

Severity is shown in the dialog and reported by `/guard list`; it does not change prompting policy yet.

## Configuration

Rules are configured by JSON files, read in this order (later layers override earlier ones):

| Layer | Path | Use |
|-------|------|-----|
| user | `<agent dir>/command-guard/rules.json` (default `~/.pi/agent/command-guard/rules.json`) | your personal rules, applies in every project |
| project | `<cwd>/.pi/command-guard/rules.json` | per-project overrides |
| package | `extensions/rules.json` | the defaults shipped with this extension; `/guard` writes here |

Arrays concatenate across layers; `updateRules` merge by rule id; scalar settings take the last layer that sets them.

```json
{
  "addRules": [
    {
      "id": "no-debug-releases",
      "label": "Deploying debug builds",
      "severity": "high",
      "explanation": "Deploying a debug build to production is risky.",
      "match": {
        "command": "^(deploy|rsync)$",
        "argAnyOf": ["--debug"]
      }
    }
  ],
  "removeRules": ["history-clear"],
  "updateRules": [
    {
      "id": "recursive-deletion",
      "explanation": "Custom wording shown in the dialog."
    }
  ],
  "enabled": true,
  "dialogTimeoutMs": 120000,
  "maxCommandLength": 20000
}
```

### Rule IDs

Built-in rules have stable string ids (`recursive-deletion`, `git-force-push`, …). The legacy positional ids (`default-0` … `default-13`) are still accepted as aliases so old configs keep targeting the same rule. Custom rules get ids like `custom-23`, `custom-24`, … unless you give them an explicit `id`.

### Pattern Format

A rule matches either by argv (`match`) or by regex (`pattern`). A pattern may be a regex string (`"\\brm\\s+-rf\\b"`) or regex-literal text (`"/\\brm\\s+-rf\\b/i"`); stateful flags (`g`, `y`) are ignored. Flags are matched as whole argv tokens, so `flagsAnyOf: ["^--?f(orce)?(-with-lease)?$"]` catches `-f`, `-rf` and `--force` without the false positives a `.*` span produces. `except` is a list of regexes: if any matches the segment, the rule does not fire.

A pattern that does not compile is reported and **disabled** (it never matches) rather than silently matching everything.

### Settings

| Key | Default | Effect |
|-----|---------|--------|
| `enabled` | `true` | master switch; set `false` in the user or project layer to disable the guard |
| `dialogTimeoutMs` | `120000` | countdown before the dialog auto-blocks (clamped to 10s–1h) |
| `maxCommandLength` | `20000` | commands longer than this are not analyzed (clamped to 200–100000) |

`rules.json` carries a `"$schema"` pointer to `rules.schema.json`, so editors validate as you type. Config problems (bad JSON, unknown keys, non-compiling patterns, wrong types) are reported to you at session start.

## The `/guard` command

```
/guard status                 enabled state, rule count, config layers, config problems
/guard list                   every rule: id, severity, label, matcher
/guard check "rm -rf build"   dry run: which rule matches and why
/guard explain <rule-id>      what a rule matches and why
/guard add <id> "<pattern>"   add a rule
/guard remove <rule-id>       remove a rule
/guard update <rule-id> "<pattern>"   replace a rule's pattern
/guard reset                  restore the built-in defaults
/guard on | off               enable/disable the guard
/guard reload                 reload config from disk
```

Edits write the package layer only, so your user and project layers are never overwritten.

## Architecture

```
LLM calls bash tool
        │
        ▼
  tool_call event fires ──► guard disabled (--no-guard / enabled:false)? ──► run command
        │
        ▼
  command parsed + matched against rules
        │
   no match ──► run command
        │
      match ──► no UI? ──► block (reason names the rule)
        │
        ▼
  overlay dialog (5 options, countdown)
        │
  ┌─────┴───────────┬──────────────┬───────────┐
  Allow          Allow rule       Edit        Block / Custom
  (exact)        (session)        │           │
  │               │               ▼           ▼
 run            run          re-check     block + (custom)
                               │          sendMessage to LLM
                          clean? run : block
```

Caching is per session: allowed commands, blocked commands and allowed rule ids are cleared on `session_start`.

## Testing

```bash
node --test tests/matchCommand.test.ts
```

The test suite uses Node's built-in test runner and `node:assert` — no test framework is installed, and there is no build step (pi loads the TypeScript through jiti, which erases types).

## License

MIT — see [LICENSE](./LICENSE).
