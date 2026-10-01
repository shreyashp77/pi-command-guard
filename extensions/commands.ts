import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  matchCommand,
  getRules,
  saveConfig,
  localConfig,
  configProblems,
  configLayerPaths,
  reloadConfig,
  isEnabled,
  type MatchResult,
} from "./patterns";
import { createInfoPanel } from "./ui";

const SUBCOMMANDS = ["status", "list", "check", "explain", "add", "remove", "update", "reset", "reload", "on", "off", "help"];

/** Autocomplete for `/guard <subcommand>`. */
export function guardArgumentCompletions(prefix: string): Array<{ value: string; label: string }> {
  const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix));
  return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : [];
}

/** Strip one layer of matching quotes so `/guard check "rm -rf /"` sees the command. */
function stripQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

export async function handleGuardCommand(args: string, ctx: ExtensionContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
  const sub = tokens[0] ?? "status";
  const rest = tokens.slice(1);

  const panel = (title: string, lines: string[]) => {
    return ctx.ui.custom<void>(createInfoPanel(title, lines), {
      overlay: true,
      overlayOptions: { anchor: "center", width: 90, maxHeight: 30 },
    });
  };

  switch (sub) {
    case "status": {
      const lines = [
        `enabled: ${isEnabled() ? "yes" : "no"}`,
        `rules active: ${getRules().length}`,
        "",
        "config layers (lowest precedence first):",
        ...configLayerPaths().map((path) => `  - ${path}`),
      ];
      const problems = configProblems();
      if (problems.length > 0) {
        lines.push("", "config problems:", ...problems.map((p) => `  ! ${p}`));
      }
      await panel("Command Guard — status", lines);
      return;
    }

    case "list": {
      const lines = getRules().map((rule) =>
        `${rule.id}  ${rule.severity}  ${rule.label}`
      );
      await panel("Command Guard — rules", lines);
      return;
    }

    case "check": {
      const command = stripQuotes(rest.join(" "));
      if (!command) {
        ctx.ui.notify('Usage: /guard check "<command>"', "warning");
        return;
      }
      const match = matchCommand(command);
      if (!match) {
        await panel("Command Guard — check", [`no rule matches: ${command}`]);
        return;
      }
      const lines = [
        `rule: ${match.rule.id}`,
        `label: ${match.rule.label}`,
        `severity: ${match.rule.severity}`,
        `matched fragment: ${match.matchedText}`,
        `explanation: ${match.rule.explanation}`,
      ];
      await panel("Command Guard — check", lines);
      return;
    }

    case "explain": {
      const target = stripQuotes(rest.join(" "));
      if (!target) {
        ctx.ui.notify("Usage: /guard explain <rule-id>", "warning");
        return;
      }
      const rule = getRules().find((r) => r.id === target || r.label.toLowerCase().includes(target.toLowerCase()));
      if (!rule) {
        ctx.ui.notify(`No rule matches "${target}"`, "warning");
        return;
      }
      const lines = [
        `id: ${rule.id}`,
        `label: ${rule.label}`,
        `severity: ${rule.severity}`,
        `explanation: ${rule.explanation}`,
        "",
        rule.pattern
          ? `pattern: ${rule.pattern.toString()}`
          : `match: ${JSON.stringify(rule.match, null, 2)}`,
      ];
      if (rule.except?.length) {
        lines.push(`except: ${rule.except!.map((e) => e.toString()).join(", ")}`);
      }
      await panel(`Command Guard — ${rule.id}`, lines);
      return;
    }

    case "add": {
      const id = stripQuotes(rest[0]);
      const pattern = stripQuotes(rest.slice(1).join(" "));
      if (!id || !pattern) {
        ctx.ui.notify('Usage: /guard add <new-id> "<pattern>"', "warning");
        return;
      }
      const config = localConfig();
      config.addRules = [...(config.addRules ?? []), { id, pattern, label: id }];
      try {
        saveConfig(config);
      } catch (err) {
        ctx.ui.notify(`Could not save config: ${err}`, "error");
        return;
      }
      ctx.ui.notify(`Rule "${id}" added to the package layer`, "info");
      return;
    }

    case "remove": {
      const id = stripQuotes(rest[0]);
      if (!id) {
        ctx.ui.notify("Usage: /guard remove <rule-id>", "warning");
        return;
      }
      const config = localConfig();
      config.removeRules = [...(config.removeRules ?? []), id];
      try {
        saveConfig(config);
      } catch (err) {
        ctx.ui.notify(`Could not save config: ${err}`, "error");
        return;
      }
      ctx.ui.notify(`Rule "${id}" removed from the effective set`, "info");
      return;
    }

    case "update": {
      const id = stripQuotes(rest[0]);
      const pattern = stripQuotes(rest.slice(1).join(" "));
      if (!id || !pattern) {
        ctx.ui.notify('Usage: /guard update <rule-id> "<new-pattern>"', "warning");
        return;
      }
      const config = localConfig();
      config.updateRules = [...(config.updateRules ?? []), { id, pattern }];
      try {
        saveConfig(config);
      } catch (err) {
        ctx.ui.notify(`Could not save config: ${err}`, "error");
        return;
      }
      ctx.ui.notify(`Rule "${id}" pattern updated in the package layer`, "info");
      return;
    }

    case "reset": {
      const config = localConfig();
      try {
        saveConfig({ enabled: config.enabled ?? true });
      } catch (err) {
        ctx.ui.notify(`Could not save config: ${err}`, "error");
        return;
      }
      ctx.ui.notify("Package-layer overrides cleared (user and project layers untouched)", "info");
      return;
    }

    case "reload": {
      const rules = reloadConfig();
      const problems = configProblems();
      const lines = [
        `rules reloaded from disk: ${rules.length}`,
        ...problems.map((p) => `  ! ${p}`),
      ];
      await panel("Command Guard — reload", lines);
      return;
    }

    case "on":
    case "off": {
      const config = localConfig();
      try {
        saveConfig({ ...config, enabled: sub === "on" });
      } catch (err) {
        ctx.ui.notify(`Could not save config: ${err}`, "error");
        return;
      }
      ctx.ui.notify(`Command guard ${sub === "on" ? "enabled" : "disabled"} for future sessions`, "info");
      return;
    }

    case "help":
    default: {
      const lines = [
        "/guard status            enabled state, rule count, config layers, problems",
        "/guard list              every active rule (id, severity, label)",
        "/guard explain <id>      why a rule exists and what it matches",
        '/guard add <id> "<re>"   add a custom rule',
        "/guard remove <id>       drop a rule",
        '/guard update <id> "<re>" replace a rule\'s pattern',
        "/guard reset             clear package-layer overrides",
        "/guard reload            re-read rules.json from disk",
        "/guard on|off            persist the master switch",
      ];
      await panel("Command Guard — help", lines);
      return;
    }
  }
}
