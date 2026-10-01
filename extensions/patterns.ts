import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the directory containing this extension file, regardless of install location
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Types ───────────────────────────────────────────────────────────────────

export type RuleSeverity = "critical" | "high" | "medium";

/**
 * A rule is either a whole-text regex (`pattern`) or an argv matcher (`match`).
 * `except` vetoes a match when a negative-context regex hits.
 */
export interface CommandRule {
  id: string;
  label: string;
  severity: RuleSeverity;
  explanation: string;
  /** Regex tested against the whole command and each shell segment. */
  pattern?: RegExp;
  /** Structured matcher evaluated against parsed argv units. */
  match?: ArgvMatch;
  /** Negative context: if any of these hit the same unit, the rule does not fire. */
  except?: RegExp[];
}

export interface ArgvMatch {
  /** Tested against any command name in the resolved chain (wrappers included). */
  command: RegExp;
  /** Require every listed regex to be matched by some flag token. */
  flagsAllOf?: RegExp[];
  /** Require at least one listed regex to be matched by some flag token. */
  flagsAnyOf?: RegExp[];
  /** Require at least one listed regex to be matched by some non-flag token. */
  argAnyOf?: RegExp[];
}

// ─── Config-facing (JSON) shapes ─────────────────────────────────────────────
// JSON can only carry strings, so patterns arrive as text and are compiled below.

interface RawArgvMatch {
  command: string;
  flagsAllOf?: string[];
  flagsAnyOf?: string[];
  argAnyOf?: string[];
}

interface RawRule {
  id?: string;
  label: string;
  severity?: RuleSeverity;
  explanation: string;
  pattern?: string | RegExp;
  match?: RawArgvMatch;
  except?: (string | RegExp)[];
}

interface ConfigFile {
  addRules?: RawRule[];
  removeRules?: string[];
  updateRules?: Array<Partial<RawRule> & { id: string }>;
  /** Master switch; persisted by the /guard command. */
  enabled?: boolean;
  /** Dialog auto-block timeout in ms (clamped when read). */
  dialogTimeoutMs?: number;
  /** Commands longer than this are rejected before analysis (clamped when read). */
  maxCommandLength?: number;
  /** JSON schema pointer for editor validation. */
  schema?: string;
}

// ─── Default Rules ───────────────────────────────────────────────────────────
// Stable string ids (see RULE_ID_ALIASES below) so user configs do not silently
// retarget when a rule is inserted, removed, or reordered.

const defaultRules: Array<RawRule & { id: string }> = [
  {
    id: "recursive-deletion",
    label: "Recursive deletion",
    severity: "critical",
    explanation:
      "Recursive deletion permanently removes files and directories without recovery. This can irreversibly destroy project data, system files, or user data.",
    match: {
      command: "^rm$",
      flagsAnyOf: ["^-r[a-z]*$|^-[a-z]*r[a-z]*$|--recursive|--no-preserve-root"],
    },
  },
  {
    id: "privilege-escalation",
    label: "Privilege escalation (sudo)",
    severity: "critical",
    explanation:
      "Running commands with elevated privileges (sudo) can modify system files, install packages globally, or perform actions that affect the entire system.",
    match: { command: "^(sudo|doas)$" },
  },
  {
    id: "permissive-permissions",
    label: "Overly permissive file permissions",
    severity: "high",
    explanation:
      "Setting overly permissive file permissions (e.g., 777) can expose sensitive files to unauthorized access by any user or process on the system.",
    match: {
      command: "^(chmod|chown)$",
      argAnyOf: ["^[0-7]{2}[67]$"],
    },
  },
  {
    id: "disk-device-operations",
    label: "Disk device operations",
    severity: "critical",
    explanation:
      "The dd command can write raw data to disk devices, potentially destroying partition tables, boot sectors, or entire filesystems.",
    match: { command: "^dd$" },
  },
  {
    id: "filesystem-creation",
    label: "Filesystem creation on devices",
    severity: "critical",
    explanation:
      "Creating a filesystem on a device will erase all existing data on that device, including operating system partitions.",
    match: { command: "^mkfs(\\.\\w+)?$" },
  },
  {
    id: "remote-exec-pipe",
    label: "Remote code execution via pipe",
    severity: "critical",
    explanation:
      "Piping downloaded content directly into a shell executes remote code without review. This is a common attack vector for installing malware.",
    pattern: "\\b(curl|wget)\\b.*\\|\\s*(sudo\\s+)?(ba)?sh\\b",
  },
  {
    id: "netcat-exec",
    label: "Netcat reverse shell / exec",
    severity: "critical",
    explanation:
      "Netcat with -e or -c flags can create reverse shells or execute arbitrary commands remotely, posing a significant security risk.",
    match: {
      command: "^(nc|ncat)$",
      flagsAnyOf: ["^-[ec]$"],
    },
  },
  {
    id: "system-dir-write",
    label: "Writing to system directories",
    severity: "high",
    explanation:
      "Writing files to critical system directories can corrupt the operating system, break package managers, or introduce malicious system-level changes.",
    match: {
      command: "^(tee|dd|cp|mv|ln|install)$",
      argAnyOf: ["^/(etc|boot|sbin|bin|usr/sbin|usr/bin|lib|sys)/"],
    },
  },
  {
    id: "redirect-system-dir",
    label: "Redirecting output into a system directory",
    severity: "high",
    explanation:
      "Redirecting output into a system directory overwrites files the operating system depends on. Prefer writing under the project directory, or use a temporary file.",
    pattern: ">>?\\s*/(etc|boot|sbin|bin|usr/s(?:bin|bin)|lib|sys)/",
  },
  {
    id: "package-uninstall",
    label: "Package manager global uninstall",
    severity: "medium",
    explanation:
      "Global package uninstallation can remove dependencies needed by other projects or system tools, potentially breaking your development environment.",
    match: {
      command: "^(npm|yarn|pnpm|pip|pip3|apt|apt-get|yum|dnf|brew)$",
      argAnyOf: ["^(uninstall|remove|purge|autoremove)$"],
    },
  },
  {
    id: "git-force-push",
    label: "Force push",
    severity: "high",
    explanation:
      "Force pushing overwrites remote history and can discard commits other people depend on. Prefer --force-with-lease after rebasing, or a plain push.",
    match: {
      command: "^git$",
      argAnyOf: ["^push$"],
      flagsAnyOf: ["^--?f(orce)?(-with-lease)?$"],
    },
  },
  {
    id: "git-reset-hard",
    label: "Discarding working-tree changes (git reset --hard)",
    severity: "high",
    explanation:
      "git reset --hard discards uncommitted changes irreversibly. Commit or stash them first if they matter.",
    match: {
      command: "^git$",
      argAnyOf: ["^reset$"],
      flagsAnyOf: ["^--hard$"],
    },
  },
  {
    id: "git-discard-checkout",
    label: "Discarding file contents (git checkout --)",
    severity: "high",
    explanation:
      "git checkout -- <path> overwrites the working tree from a commit, permanently discarding uncommitted edits in those files.",
    match: {
      command: "^git$",
      argAnyOf: ["^checkout$"],
      flagsAnyOf: ["^--$"],
    },
  },
  {
    id: "git-clean-force",
    label: "Deleting untracked files (git clean)",
    severity: "high",
    explanation:
      "git clean with -f (especially -fdx) deletes untracked and ignored files, which often include build outputs, secrets, and local-only data.",
    match: {
      command: "^git$",
      argAnyOf: ["^clean$"],
      flagsAnyOf: ["^-[a-z]*[fx][a-z]*$"],
    },
  },
  {
    id: "truncate-empty",
    label: "Emptying file contents",
    severity: "high",
    explanation:
      "Truncating a file to zero bytes permanently erases all its contents without any recovery option.",
    match: {
      command: "^truncate$",
      flagsAnyOf: ["^-s$"],
      argAnyOf: ["^0$"],
    },
  },
  {
    id: "kill-sigkill",
    label: "Kill all processes",
    severity: "high",
    explanation:
      "Sending SIGKILL (-9) to processes terminates them immediately without cleanup, potentially leaving the system in an inconsistent state.",
    match: {
      command: "^(kill|killall|pkill)$",
      flagsAnyOf: ["^-(9|KILL|SIGKILL)$"],
    },
  },
  {
    id: "mkswap",
    label: "Formatting with mkswap",
    severity: "critical",
    explanation:
      "mkswap initializes a swap area on a device, erasing all existing data on that partition.",
    match: { command: "^mkswap$" },
  },
  {
    id: "eval-remote",
    label: "Dangerous eval / source of remote content",
    severity: "critical",
    explanation:
      "Evaluating or sourcing content downloaded from the internet executes arbitrary code without review.",
    pattern: "\\b(eval|source)\\s+.*(curl|wget)\\b",
  },
  {
    id: "find-delete",
    label: "Deleting files with find -delete",
    severity: "high",
    explanation:
      "find -delete removes every matched file immediately and evaluates predicates left to right, so a misplaced test can match far more than intended.",
    match: {
      command: "^find$",
      flagsAnyOf: ["^--?delete$"],
    },
  },
  {
    id: "block-device-redirect",
    label: "Redirecting output to a block device",
    severity: "critical",
    explanation:
      "Writing to a raw block device such as /dev/sda overwrites the partition contents directly, with no confirmation from the tool.",
    pattern: ">\\s*/dev/(sd[a-z][0-9]*|nvme\\d+\\w*|hd[a-z])\\b",
  },
  {
    id: "fork-bomb",
    label: "Fork bomb",
    severity: "critical",
    explanation:
      "A fork bomb recursively spawns processes without bound, exhausting processes and memory until the system becomes unusable.",
    pattern: ":\\s*\\(\\s*\\)\\s*\\{.*:\\s*\\|\\s*:.*&",
  },
  {
    id: "shutdown-system",
    label: "Powering off or restarting the system",
    severity: "high",
    explanation:
      "Shutting down or rebooting terminates the running environment immediately, which can interrupt work in progress and lose unsaved state.",
    match: {
      command: "^(shutdown|reboot|halt|poweroff|init)$",
    },
  },
  {
    id: "history-clear",
    label: "Clearing shell history",
    severity: "medium",
    explanation:
      "Clearing shell history erases previously run commands, which people often rely on to recover paths, commands, or session state.",
    match: {
      command: "^history$",
      flagsAnyOf: ["^-c$"],
    },
  },
];

// Legacy positional ids still accepted so existing user configs keep working.
// The old single "Dangerous git operations" rule (default-9) now maps to
// git-force-push; the other git variants are new ids.
const RULE_ID_ALIASES: Record<string, string> = {
  "default-0": "recursive-deletion",
  "default-1": "privilege-escalation",
  "default-2": "permissive-permissions",
  "default-3": "disk-device-operations",
  "default-4": "filesystem-creation",
  "default-5": "remote-exec-pipe",
  "default-6": "netcat-exec",
  "default-7": "system-dir-write",
  "default-8": "package-uninstall",
  "default-9": "git-force-push",
  "default-10": "truncate-empty",
  "default-11": "kill-sigkill",
  "default-12": "mkswap",
  "default-13": "eval-remote",
};

// ─── Pattern compilation ─────────────────────────────────────────────────────

/** Compiles to a pattern that cannot match any string. */
const NEVER_MATCH: RegExp = new RegExp("((?!))");

/**
 * Compile a config-supplied pattern.
 *
 * Two forms are accepted:
 *  - regex literal with explicit flags: `"/\\brm\\s+-rf\\b/g"`
 *  - raw pattern source:               `"\\brm\\s+-rf\\b"`
 *
 * The literal form requires a non-empty flags segment, otherwise a raw pattern such as
 * `/tmp/` would silently lose its slashes and match `tmp` anywhere in the command.
 *
 * Failure mode is deliberately **never-matching**, not match-everything: a malformed
 * pattern must not turn its rule into a rule that blocks every command.
 *
 * The global flag is dropped: rules are only used with `.test()`, and a global regex
 * carries `lastIndex` state that would be shared across concurrent tool calls.
 */
/** Compiles a pattern source; throws when the source is not a valid regex. */
function compilePatternSource(s: string, context: string): RegExp {
  const literal = s.match(/^\/(.+)\/([gimsuy]+)$/);
  if (literal) {
    return new RegExp(literal[1], literal[2].replace(/[gy]/g, ""));
  }
  return new RegExp(s, "");
}

function stringToRegex(s: string, context: string): RegExp {
  try {
    return compilePatternSource(s, context);
  } catch (err) {
    console.warn(
      `[command-guard] Invalid pattern ${JSON.stringify(s)} in rule "${context}"; ` +
        "the rule is disabled (it will never match): " +
        `${(err as Error).message ?? err}`,
    );
    return NEVER_MATCH;
  }
}

function toRegExpSource(source: string | RegExp, context: string): RegExp {
  if (source instanceof RegExp) return stripStatefulFlags(source);
  return stringToRegex(source, context);
}

/** Removes `g`/`y` so the compiled regex keeps no `lastIndex` state. */
function stripStatefulFlags(re: RegExp): RegExp {
  const flags = re.flags.replace(/[gy]/g, "");
  return new RegExp(re.source, flags);
}

function compileArgvMatch(raw: RawArgvMatch): ArgvMatch {
  const compiled: ArgvMatch = {
    command: stringToRegex(raw.command, "argv.command"),
  };
  if (raw.flagsAllOf) {
    compiled.flagsAllOf = raw.flagsAllOf.map((f, i) => stringToRegex(f, `argv.flagsAllOf[${i}]`));
  }
  if (raw.flagsAnyOf) {
    compiled.flagsAnyOf = raw.flagsAnyOf.map((f, i) => stringToRegex(f, `argv.flagsAnyOf[${i}]`));
  }
  if (raw.argAnyOf) {
    compiled.argAnyOf = raw.argAnyOf.map((a, i) => stringToRegex(a, `argv.argAnyOf[${i}]`));
  }
  return compiled;
}

function compileRule(raw: RawRule, id: string): CommandRule {
  const rule: CommandRule = {
    id,
    label: raw.label,
    severity: raw.severity ?? "high",
    explanation: raw.explanation,
  };
  if (raw.pattern !== undefined) {
    rule.pattern = toRegExpSource(raw.pattern, id);
  }
  if (raw.match !== undefined) {
    rule.match = compileArgvMatch(raw.match);
  }
  if (raw.except !== undefined) {
    rule.except = raw.except.map((e, i) =>
      e instanceof RegExp ? stripStatefulFlags(e) : stringToRegex(e, `${id}.except[${i}]`),
    );
  }
  return rule;
}

// ─── Config layers ───────────────────────────────────────────────────────────
// Three layers, lowest precedence first. A later layer wins over an earlier one:
//   1. user     <agent-dir>/command-guard/rules.json   (agent-dir = PI_CODING_AGENT_DIR or ~/.pi/agent)
//   2. project  .pi/command-guard/rules.json under the working directory
//   3. package  rules.json next to this extension (the shipped template)
const LOCAL_CONFIG_PATH = join(__dirname, "rules.json");

export function configLayerPaths(): string[] {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
  return [
    join(agentDir, "command-guard", "rules.json"),
    join(process.cwd(), ".pi", "command-guard", "rules.json"),
    LOCAL_CONFIG_PATH,
  ];
}

/** Problems found while reading the config layers; surfaced to the user by the UI layer. */
let configProblemsFound: string[] = [];

export function configProblems(): string[] {
  return configProblemsFound;
}

// ─── Load config ─────────────────────────────────────────────────────────────

/** Parse one layer, validating it and recording human-readable problems. */
function readConfigLayer(path: string): ConfigFile {
  if (!existsSync(path)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    configProblemsFound.push(`${path}: not valid JSON (${err}); layer ignored`);
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    configProblemsFound.push(`${path}: expected an object, got something else; layer ignored`);
    return {};
  }

  const knownKeys = ["addRules", "removeRules", "updateRules", "enabled", "schema", "$schema", "dialogTimeoutMs", "maxCommandLength"];
  for (const key of Object.keys(parsed)) {
    if (!knownKeys.includes(key)) {
      configProblemsFound.push(`${path}: unknown key "${key}" ignored`);
    }
  }

  const config = parsed as ConfigFile;
  if ((parsed as any)["$schema"] !== undefined) {
    config.schema = (parsed as any)["$schema"];
    delete (config as any)["$schema"];
  }

  if (config.addRules) {
    if (!Array.isArray(config.addRules)) {
      configProblemsFound.push(`${path}: "addRules" must be an array`);
      config.addRules = [];
    }
    for (const raw of config.addRules) {
      if (typeof raw !== "object" || raw === null) {
        configProblemsFound.push(`${path}: addRules entry is not an object`);
        continue;
      }
      const id = raw.id ?? "(unnamed)";
      if (!raw.pattern && !raw.match) {
        configProblemsFound.push(`${path}: addRules rule "${id}" has neither pattern nor match — it can never match`);
      }
      if (raw.pattern !== undefined && typeof raw.pattern !== "string" && !(raw.pattern instanceof RegExp)) {
        configProblemsFound.push(`${path}: addRules rule "${id}" has a non-string pattern`);
      }
      if (raw.pattern !== undefined && !patternCompiles(raw.pattern)) {
        configProblemsFound.push(`${path}: addRules rule "${id}" has a pattern that does not compile — it will never match`);
      }
    }
  }

  if (config.removeRules && !Array.isArray(config.removeRules)) {
    configProblemsFound.push(`${path}: "removeRules" must be an array of rule ids`);
    config.removeRules = [];
  }

  if (config.updateRules) {
    if (!Array.isArray(config.updateRules)) {
      configProblemsFound.push(`${path}: "updateRules" must be an array`);
      config.updateRules = [];
    }
    for (const update of config.updateRules) {
      if (typeof update !== "object" || update === null || typeof update.id !== "string") {
        configProblemsFound.push(`${path}: updateRules entry must be an object with a string "id"`);
      }
    }
  }

  if (config.dialogTimeoutMs !== undefined && typeof config.dialogTimeoutMs !== "number") {
    configProblemsFound.push(`${path}: "dialogTimeoutMs" must be a number of milliseconds`);
  }
  if (config.maxCommandLength !== undefined && typeof config.maxCommandLength !== "number") {
    configProblemsFound.push(`${path}: "maxCommandLength" must be a number of characters`);
  }

  return config;
}

/** Merge the layers into one config: arrays concatenate, scalars take the last layer. */
function loadConfig(): ConfigFile {
  configProblemsFound = [];
  const merged: ConfigFile = { addRules: [], removeRules: [], updateRules: [] };
  for (const path of configLayerPaths()) {
    const layer = readConfigLayer(path);
    if (layer.addRules?.length) merged.addRules!.push(...layer.addRules);
    if (layer.removeRules?.length) merged.removeRules!.push(...layer.removeRules);
    if (layer.updateRules?.length) {
      for (const update of layer.updateRules) {
        const idx = merged.updateRules!.findIndex((u) => u.id === update.id);
        if (idx === -1) merged.updateRules!.push(update);
        else merged.updateRules![idx] = { ...merged.updateRules![idx], ...update };
      }
    }
    if (layer.enabled !== undefined) merged.enabled = layer.enabled;
    if (layer.dialogTimeoutMs !== undefined) merged.dialogTimeoutMs = layer.dialogTimeoutMs;
    if (layer.maxCommandLength !== undefined) merged.maxCommandLength = layer.maxCommandLength;
  }
  return merged;
}

/** True when a raw pattern value compiles; false when it would hit the NEVER_MATCH fallback. */
function patternCompiles(raw: unknown): boolean {
  if (raw instanceof RegExp) return true;
  if (typeof raw !== "string") return false;
  try {
    compilePatternSource(raw, "validation");
    return true;
  } catch {
    return false;
  }
}

/** The package layer on its own — what the /guard command edits back. */
export function localConfig(): ConfigFile {
  return readConfigLayer(LOCAL_CONFIG_PATH);
}

/** Merged view of every config layer (what the /guard command edits back). */
export function currentConfig(): ConfigFile {
  return loadConfig();
}

/** Master switch, merged across layers (default: on). */
export function isEnabled(): boolean {
  return currentConfig().enabled ?? true;
}

const MIN_DIALOG_TIMEOUT_MS = 10_000;
const MAX_DIALOG_TIMEOUT_MS = 3_600_000;
const MIN_COMMAND_LENGTH = 200;
const MAX_COMMAND_LENGTH = 100_000;
/** Defaults for the analysis cap and dialog timeout; overridable per config layer. */
const DEFAULT_PATTERN_INPUT = 20_000;
const DEFAULT_DIALOG_TIMEOUT_MS = 120_000;

/** Dialog timeout in ms, clamped so a bad config cannot make the dialog hang forever. */
export function dialogTimeoutMs(): number {
  const raw = currentConfig().dialogTimeoutMs;
  if (typeof raw !== "number" || Number.isNaN(raw)) return DEFAULT_DIALOG_TIMEOUT_MS;
  return Math.min(MAX_DIALOG_TIMEOUT_MS, Math.max(MIN_DIALOG_TIMEOUT_MS, Math.round(raw)));
}

/** Maximum command length analyzed by the guard, clamped. */
export function maxCommandLength(): number {
  const raw = currentConfig().maxCommandLength;
  if (typeof raw !== "number" || Number.isNaN(raw)) return DEFAULT_PATTERN_INPUT;
  return Math.min(MAX_COMMAND_LENGTH, Math.max(MIN_COMMAND_LENGTH, Math.round(raw)));
}

// ─── Build rules ─────────────────────────────────────────────────────────────

let cachedRules: CommandRule[] | null = null;
/** Analysis cap for the current rule set (see maxCommandLength()). */
let cachedAnalysisLimit = DEFAULT_PATTERN_INPUT;

export function getRules(): CommandRule[] {
  if (cachedRules) return cachedRules;

  const config = loadConfig();
  cachedAnalysisLimit = maxCommandLength();

  const rules: CommandRule[] = defaultRules.map((r) => compileRule(r, r.id));
  // Remove specified rules (legacy positional ids are accepted)
  if (config.removeRules?.length) {
    const removeSet = new Set(config.removeRules.map(normalizeRuleId));
    const kept = rules.filter((r) => !removeSet.has(r.id));
    rules.splice(0, rules.length, ...kept);
  }

  // Update specified rules
  if (config.updateRules?.length) {
    for (const update of config.updateRules) {
      const targetId = normalizeRuleId(update.id);
      const idx = rules.findIndex((r) => r.id === targetId);
      if (idx === -1) continue;

      const existing = rules[idx];
      rules[idx] = {
        id: existing.id,
        label: update.label ?? existing.label,
        severity: update.severity ?? existing.severity,
        explanation: update.explanation ?? existing.explanation,
        pattern: update.pattern !== undefined
          ? toRegExpSource(update.pattern, existing.id)
          : existing.pattern,
        match: update.match !== undefined
          ? compileArgvMatch(update.match)
          : existing.match,
        except: update.except !== undefined
          ? update.except.map((e, i) =>
              e instanceof RegExp ? stripStatefulFlags(e) : stringToRegex(e, `${existing.id}.except[${i}]`),
            )
          : existing.except,
      };
    }
  }

  // Add extra rules
  if (config.addRules?.length) {
    let nextId = defaultRules.length;
    for (const r of config.addRules) {
      const id = r.id ?? `custom-${nextId++}`;
      rules.push(compileRule(r, normalizeRuleId(id)));
    }
  }

  cachedRules = rules;
  return rules;
}

/**
 * Re-read the config layers from disk and rebuild the rule set. Use this after
 * editing `rules.json` outside of pi so the change takes effect without
 * restarting the session.
 */
export function reloadConfig(): CommandRule[] {
  cachedRules = null;
  return getRules();
}

function normalizeRuleId(id: string): string {
  return RULE_ID_ALIASES[id] ?? id;
}

// ─── Shell parsing helpers ───────────────────────────────────────────────────
// Deliberately minimal: enough to reason about command position and flags without
// a full shell grammar. Anything it cannot parse is treated conservatively.

/** Commands that wrap another command, so the real command sits after them. */
const WRAPPER_COMMANDS = new Set([
  "sudo", "doas", "env", "time", "nice", "nohup", "stdbuf", "xargs", "parallel",
]);

/** Shells whose -c argument contains a nested command string. */
const EXEC_SHELLS = new Set(["bash", "sh", "zsh", "ksh", "dash", "fish"]);

/** Split a command line into segments on unquoted ; && || | and newlines. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") i++;
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") i++;
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Tokenize one segment, honouring single and double quotes. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: string | null = null;
  let started = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += ch;
    started = true;
  }
  if (started) tokens.push(token);
  return tokens;
}

interface Unit {
  text: string;
  chain: string[];
  flags: string[];
  args: string[];
}

/**
 * Resolve one segment into a matchable unit: the command chain (wrappers first),
 * plus flag and argument tokens, plus any nested command strings.
 */
function collectUnits(segment: string, depth = 0): Unit[] {
  const units: Unit[] = [];
  if (depth > 2) return units;

  const tokens = tokenize(segment);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;

  const chain: string[] = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (WRAPPER_COMMANDS.has(t)) {
      chain.push(t);
      i++;
      while (i < tokens.length && (tokens[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
      continue;
    }
    chain.push(t);
    i++;
    break;
  }

  const rest = tokens.slice(i);
  const flags: string[] = [];
  const args: string[] = [];
  for (const t of rest) {
    if (t.startsWith("-")) flags.push(t);
    else args.push(t);
  }

  units.push({ text: segment, chain, flags, args });

  // Nested command strings: `bash -c "..."`, `xargs <cmd>`.
  const leaf = chain[chain.length - 1];
  if (leaf !== undefined) {
    if (EXEC_SHELLS.has(leaf)) {
      const cIndex = rest.findIndex((t) => /^-c$/.test(t));
      if (cIndex !== -1 && cIndex + 1 < rest.length) {
        units.push(...collectUnits(rest[cIndex + 1], depth + 1));
      }
    }
    if (leaf === "xargs" || leaf === "parallel") {
      units.push(...collectUnits(rest.join(" "), depth + 1));
    }
  }

  return units;
}

// ─── Matching ────────────────────────────────────────────────────────────────

export interface MatchResult {
  rule: CommandRule;
  /** The fragment that actually matched: a segment, or the regex match text. */
  matchedText: string;
}

function matchesArgv(rule: CommandRule, unit: Unit): boolean {
  const m = rule.match;
  if (!m) return false;

  if (!unit.chain.some((name) => m.command.test(name))) return false;

  if (m.flagsAllOf && !m.flagsAllOf.every((re) => unit.flags.some((f) => re.test(f)))) return false;
  if (m.flagsAnyOf && !m.flagsAnyOf.some((re) => unit.flags.some((f) => re.test(f)))) return false;
  if (m.argAnyOf && !m.argAnyOf.some((re) => unit.args.some((a) => re.test(a)))) return false;

  return true;
}

function vetoesExcept(rule: CommandRule, text: string, unit: Unit): boolean {
  if (!rule.except) return false;
  for (const re of rule.except) {
    if (re.test(text)) return true;
    if (unit.flags.some((f) => re.test(f)) || unit.args.some((a) => re.test(a))) return true;
  }
  return false;
}

export function matchCommand(command: string): MatchResult | null {
  const rules = getRules();
  const segments = splitSegments(command);
  const units = segments.flatMap((s) => collectUnits(s));
  const patternInput = command.length > cachedAnalysisLimit ? command.slice(0, cachedAnalysisLimit) : command;

  for (const rule of rules) {
    // 1. Whole-text patterns (cross-segment shapes such as `curl … | sh`).
    if (rule.pattern && rule.pattern.test(patternInput)) {
      return { rule, matchedText: patternFragment(rule.pattern, patternInput) ?? command };
    }

    // 2. Structured argv matching, per segment (and nested command strings).
    if (rule.match) {
      for (const unit of units) {
        if (!matchesArgv(rule, unit)) continue;
        const text = unit.text;
        if (vetoesExcept(rule, text, unit)) continue;
        return { rule, matchedText: text };
      }
    }
  }
  return null;
}

/** Best-effort matched substring, for display; falls back to null. */
function patternFragment(pattern: RegExp, input: string): string | null {
  const found = input.match(pattern);
  return found ? found[0] : null;
}

// ─── Save config helper ──────────────────────────────────────────────────────

/** Write the package-level layer, creating its directory if needed. */
export function saveConfig(config: ConfigFile): void {
  try {
    const dir = dirname(LOCAL_CONFIG_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const payload = { ...config };
    delete payload.schema;
    const schemaPointer = config.schema ?? localConfig().schema;
    if (schemaPointer !== undefined) payload["$schema"] = schemaPointer;
    writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    cachedRules = null; // Invalidate cache
    configProblemsFound = []; // Next getRules() re-reads the layers
  } catch (err) {
    throw new Error(`[command-guard] could not save rules config: ${err}`);
  }
}
