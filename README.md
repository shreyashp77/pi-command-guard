# pi-command-guard

A global [pi](https://pi.dev) extension that intercepts potentially dangerous bash commands and prompts the user for confirmation before execution.

## Features

- **Intercept dangerous commands** — Detects 14 categories of risky shell operations before they run
- **Three-way decision** — Allow, Block, or provide Custom Instructions for the LLM to suggest a safer alternative
- **Session-aware caching** — If you allow a command once in a session, it won't prompt again for the same command
- **Configurable rules** — Add, remove, or modify detection rules via a simple JSON config file
- **Non-interactive safety** — Blocks by default when running in print/JSON mode (no UI available)
- **Styled overlay dialog** — Clear explanation of why the command was flagged, displayed with syntax-highlighted command text

## Installation

### Quick install (recommended)

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

After installing, you should see the extension loaded in pi's logs. Test it by asking the LLM to run a command like `rm -rf node_modules` — the guard dialog should appear with three options: **Allow**, **Block**, or **Custom Instructions**.

## How It Works

When the LLM calls the `bash` tool with a command, the extension checks it against a set of dangerous command patterns:

1. **Detection** — Regex patterns match against the command string
2. **Dialog** — A styled overlay appears with the command, rule label, and explanation
3. **Decision** — Choose one of three options:

| Option | What happens |
|--------|-------------|
| **Allow** | The command runs as intended. Cached for the session. |
| **Block** | The command is cancelled with a reason. |
| **Custom Instructions** | You type what you actually want to do in natural language. The original command is blocked, and the LLM receives both the blocked command and your instructions, so it can suggest a safer alternative. |

## Built-in Rules

| # | Rule | Patterns |
|---|------|----------|
| 1 | Recursive deletion | `rm -rf`, `rm -r`, `rm --recursive`, `rm --no-preserve-root` |
| 2 | Privilege escalation | `sudo` |
| 3 | Overly permissive permissions | `chmod 777`, `chmod 666`, `chmod 776`, `chown` with same |
| 4 | Disk device operations | `dd` |
| 5 | Filesystem creation | `mkfs`, `mkfs.ext4`, etc. |
| 6 | Remote code execution via pipe | `curl \| bash`, `wget \| sh`, `curl \| sudo sh` |
| 7 | Netcat reverse shell | `nc -e`, `nc -c` |
| 8 | Writing to system directories | Writing to `/etc/`, `/boot/`, `/sbin/`, `/usr/sbin/`, `/bin/` |
| 9 | Package manager global uninstall | `npm uninstall`, `pip uninstall`, `apt purge`, `brew autoremove`, etc. |
| 10 | Dangerous git operations | `git push --force`, `git reset --hard`, `git push --force-with-lease` |
| 11 | Emptying file contents | `truncate -s 0` |
| 12 | Kill all processes | `kill -9`, `kill --kill` |
| 13 | Swap formatting | `mkswap` |
| 14 | Dangerous eval/source | `eval` or `source` with `curl`/`wget` |

## Configuration

Edit `rules.json` to customize detection rules:

```json
{
  "addRules": [
    {
      "label": "My custom rule",
      "pattern": "/\\bmy-dangerous\\b/g",
      "explanation": "This command does something risky."
    }
  ],
  "removeRules": [
    "default-2"
  ],
  "updateRules": [
    {
      "id": "default-0",
      "pattern": "/\\brm\\s+-rf\\b/g",
      "explanation": "Updated explanation for recursive deletion."
    }
  ]
}
```

### Rule IDs

Default rules are auto-assigned IDs `default-0` through `default-13` (in order of definition). Custom rules get IDs like `custom-14`, `custom-15`, etc.

### Pattern Format

Patterns can be specified as:
- A regex string: `"\\brm\\s+-rf\\b"`
- A regex literal: `"/\\brm\\s+-rf\\b/g"`

## Architecture

```
LLM calls bash tool
        │
        ▼
  tool_call event fires
        │
        ▼
  Command checked against patterns
        │
        ▼
  Dangerous? ───No──→ Let it run
        │
       Yes
        │
        ▼
  Show overlay dialog
        │
   ┌────┼────┬──────────┐
   Yes   No  Custom
   │      │     │
   ▼      ▼     ▼
 Run     Block  Input dialog
 command  cmd    "What do
               you want
               to do
               instead?"
                   │
                   ▼
            Block original,
            send context +
            user intent to LLM
```

## License

MIT
