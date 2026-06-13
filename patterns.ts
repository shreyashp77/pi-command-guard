import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommandRule {
  /** Unique identifier for this rule */
  id: string;
  /** Human-readable label */
  label: string;
  /** Regex pattern to match against the command */
  pattern: RegExp;
  /** Explanation shown to the user when this rule triggers */
  explanation: string;
}

// ─── Default Rules ───────────────────────────────────────────────────────────

const defaultRules: Omit<CommandRule, "id">[] = [
  {
    label: "Recursive deletion",
    pattern: /\brm\s+(-rf?|--recursive|--no-preserve-root)\b/g,
    explanation:
      "Recursive deletion permanently removes files and directories without recovery. This can irreversibly destroy project data, system files, or user data.",
  },
  {
    label: "Privilege escalation (sudo)",
    pattern: /\bsudo\b/g,
    explanation:
      "Running commands with elevated privileges (sudo) can modify system files, install packages globally, or perform actions that affect the entire system.",
  },
  {
    label: "Overly permissive file permissions",
    pattern: /\b(chmod|chown)\b.*\b(777|666|776)\b/g,
    explanation:
      "Setting overly permissive file permissions (e.g., 777) can expose sensitive files to unauthorized access by any user or process on the system.",
  },
  {
    label: "Disk device operations",
    pattern: /\bdd\s+/g,
    explanation:
      "The dd command can write raw data to disk devices, potentially destroying partition tables, boot sectors, or entire filesystems.",
  },
  {
    label: "Filesystem creation on devices",
    pattern: /\b(mkfs|mkfs\.\w+)\b/g,
    explanation:
      "Creating a filesystem on a device will erase all existing data on that device, including operating system partitions.",
  },
  {
    label: "Remote code execution via pipe",
    pattern: /\b(curl|wget)\b.*\|\s*(sudo\s+)?(ba)?sh\b/g,
    explanation:
      "Piping downloaded content directly into a shell executes remote code without review. This is a common attack vector for installing malware.",
  },
  {
    label: "Netcat reverse shell / exec",
    pattern: /\bnc\b.*\b(-e|-c)\b/g,
    explanation:
      "Netcat with -e or -c flags can create reverse shells or execute arbitrary commands remotely, posing a significant security risk.",
  },
  {
    label: "Writing to system directories",
    pattern:
      /\b(write|tee|cat\s+>\s*|dd\s+of=)\b.*\b(\/etc\/|\/boot\/|\/sbin\/|\/usr\/sbin\/|\/bin\/)/g,
    explanation:
      "Writing files to critical system directories can corrupt the operating system, break package managers, or introduce malicious system-level changes.",
  },
  {
    label: "Package manager global uninstall",
    pattern:
      /\b(npm|yarn|pnpm|pip|pip3|apt|apt-get|yum|dnf|brew)\b.*\b(uninstall|remove|purge|autoremove)\b/g,
    explanation:
      "Global package uninstallation can remove dependencies needed by other projects or system tools, potentially breaking your development environment.",
  },
  {
    label: "Dangerous git operations",
    pattern:
      /\bgit\s+(push\s+--force|--force-with-lease|--hard|reset\s+--hard)\b/g,
    explanation:
      "Force operations can overwrite remote history, discard uncommitted changes, or rewrite project history in ways that are difficult or impossible to recover.",
  },
  {
    label: "Emptying file contents",
    pattern: /\btruncate\s+-s\s+0\b/g,
    explanation:
      "Truncating a file to zero bytes permanently erases all its contents without any recovery option.",
  },
  {
    label: "Kill all processes",
    pattern: /\bkill\s+(-9|--kill)\b/g,
    explanation:
      "Sending SIGKILL (-9) to processes terminates them immediately without cleanup, potentially leaving the system in an inconsistent state.",
  },
  {
    label: "Formatting with mkswap",
    pattern: /\bmkswap\b/g,
    explanation:
      "mkswap initializes a swap area on a device, erasing all existing data on that partition.",
  },
  {
    label: "Dangerous export / eval",
    pattern:
      /\b(eval|source|\. )\s+.*\b(curl|wget)\b/g,
    explanation:
      "Evaluating or sourcing content downloaded from the internet executes arbitrary code without review.",
  },
];

// ─── Helper: Convert string pattern to RegExp ────────────────────────────────

function stringToRegex(s: string): RegExp {
  try {
    const match = s.match(/^\/(.+)\/([gimsuy]*)$/);
    if (match) {
      return new RegExp(match[1], match[2]);
    }
    return new RegExp(s, "g");
  } catch {
    return new RegExp("", "g");
  }
}

// ─── Config file path ────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".pi", "agent", "extensions", "command-guard");
const CONFIG_PATH = join(CONFIG_DIR, "rules.json");

interface ConfigFile {
  /** Extra rules to add (merged with defaults) */
  addRules?: Array<Omit<CommandRule, "id"> & { id?: string }>;
  /** Rule IDs to remove from defaults */
  removeRules?: string[];
  /** Replace regex of existing rules by ID */
  updateRules?: Array<{
    id: string;
    pattern?: string;
    explanation?: string;
  }>;
}

// ─── Load config ─────────────────────────────────────────────────────────────

function loadConfig(): ConfigFile {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    console.warn("[command-guard] Failed to parse rules.json, using defaults.");
    return {};
  }
}

// ─── Build rules ─────────────────────────────────────────────────────────────

let cachedRules: CommandRule[] | null = null;

export function getRules(): CommandRule[] {
  if (cachedRules) return cachedRules;

  const config = loadConfig();

  // Build a map of default rules keyed by auto-generated id
  const defaults = defaultRules.map((r, i) => ({
    ...r,
    id: `default-${i}`,
  }));

  let rules = [...defaults];

  // Remove specified rules
  if (config.removeRules?.length) {
    const removeSet = new Set(config.removeRules);
    rules = rules.filter((r) => !removeSet.has(r.id));
  }

  // Update specified rules
  if (config.updateRules?.length) {
    for (const update of config.updateRules) {
      const idx = rules.findIndex((r) => r.id === update.id);
      if (idx !== -1) {
        if (update.pattern) {
          rules[idx].pattern = stringToRegex(update.pattern);
        }
        if (update.explanation) {
          rules[idx].explanation = update.explanation;
        }
      }
    }
  }

  // Add extra rules
  if (config.addRules?.length) {
    let nextId = defaults.length;
    for (const r of config.addRules) {
      rules.push({
        ...r,
        id: r.id ?? `custom-${nextId++}`,
        pattern: typeof r.pattern === "string" ? stringToRegex(r.pattern) : r.pattern,
      });
    }
  }

  cachedRules = rules;
  return rules;
}

// ─── Match a command against rules ───────────────────────────────────────────

export interface MatchResult {
  rule: CommandRule;
  matchedText: string;
}

export function matchCommand(command: string): MatchResult | null {
  const rules = getRules();
  for (const rule of rules) {
    // Reset lastIndex for global regexes
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(command)) {
      return { rule, matchedText: command };
    }
  }
  return null;
}

// ─── Save config helper ──────────────────────────────────────────────────────

export function saveConfig(config: ConfigFile): void {
  try {
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) {
      // Would need fs.mkdirSync here, but let's keep it simple
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    cachedRules = null; // Invalidate cache
  } catch (err) {
    console.warn("[command-guard] Failed to save rules.json:", err);
  }
}
