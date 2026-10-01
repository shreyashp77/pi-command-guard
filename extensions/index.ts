import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchCommand, type MatchResult, isEnabled, configProblems, getRules, dialogTimeoutMs, maxCommandLength } from "./patterns";
import {
  createGuardDialog,
  createInputDialog,
  createGuardMessageRenderer,
  type GuardDialogResult,
} from "./ui";
import { handleGuardCommand, guardArgumentCompletions } from "./commands";

export default function (pi: ExtensionAPI) {
  // ─── Session state ─────────────────────────────────────────────────────────
  // Three kinds of memory, all per pi session:
  //  - allowedCommands: exact rule+command pairs the user allowed (hit count kept for stats)
  //  - blockedCommands: exact pairs the user blocked, so the same command does not re-prompt
  //  - allowedRules:    rule ids allowed for the whole session, regardless of arguments
  const allowedCommands = new Map<string, number>();
  const blockedCommands = new Map<string, number>();
  const allowedRules = new Set<string>();
  const stats = { prompts: 0, allowed: 0, blocked: 0 };
  let pendingDialogs = 0;

  pi.on("session_start", async (_event, ctx) => {
    allowedCommands.clear();
    blockedCommands.clear();
    allowedRules.clear();
    stats.prompts = 0;
    stats.allowed = 0;
    stats.blocked = 0;
    pendingDialogs = 0;

    // Warm the rule cache once and surface any config problems to the user.
    getRules();
    for (const problem of configProblems()) {
      ctx.ui.notify(`command-guard: ${problem}`, "warning");
    }
  });

  // `/guard …` inspects and edits the rule configuration.
  pi.registerCommand("guard", {
    description: "Inspect and edit command-guard rules (status, list, explain, add, remove, update, reset, on, off)",
    getArgumentCompletions: (prefix) => guardArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      await handleGuardCommand(args, ctx);
    },
  });

  // `--no-guard` disables the guard for a single run.
  pi.registerFlag("no-guard", {
    description: "Disable the command guard for this run",
    type: "boolean",
    default: false,
  });

  // Style the injected "command guard" context message in the transcript.
  pi.registerMessageRenderer("command-guard", createGuardMessageRenderer());

  // ─── tool_call handler: intercept dangerous bash commands ─────────────────
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    if (typeof command !== "string" || command.trim().length === 0) return;

    const timeoutMs = dialogTimeoutMs();
    const analysisLimit = maxCommandLength();

    const match = matchCommand(command);
    if (!match) return;

    // Master switches: persisted config (`enabled`) and the `--no-guard` CLI flag.
    if (!isEnabled() || pi.getFlag("no-guard") === true) return;

    // Security boundary: a rule-matched command must never run when the user cannot
    // see the guard dialog. Commands that match no rule still pass through.
    if (!ctx.hasUI) {
      stats.blocked++;
      updateStatus(ctx);
      return {
        block: true,
        reason: `Command guard: ${match.rule.label} blocked (no UI for confirmation)`,
      };
    }

    const decisionKey = `${match.rule.id}:${command.trim()}`;

    // Silent decisions — no dialog, but the status line reflects them.
    if (allowedRules.has(match.rule.id)) {
      stats.allowed++;
      updateStatus(ctx);
      return;
    }

    const allowedHits = allowedCommands.get(decisionKey);
    if (allowedHits) {
      allowedCommands.set(decisionKey, allowedHits + 1);
      stats.allowed++;
      updateStatus(ctx);
      return;
    }

    const blockedHits = blockedCommands.get(decisionKey);
    if (blockedHits) {
      blockedCommands.set(decisionKey, blockedHits + 1);
      stats.blocked++;
      updateStatus(ctx);
      return {
        block: true,
        reason: `Command guard: blocked by user earlier this session (${match.rule.label})`,
      };
    }

    // Show the guard dialog
    const result = await showGuardDialog(match, command, ctx, timeoutMs);

    if (!result) {
      stats.blocked++;
      updateStatus(ctx);
      return { block: true, reason: "Command guard: blocked by user (cancelled)" };
    }

    if (result.timedOut) {
      stats.blocked++;
      updateStatus(ctx);
      return {
        block: true,
        reason: `Command guard: blocked (no decision within ${Math.round(timeoutMs / 1000)}s)`,
      };
    }

    switch (result.choice) {
      case "allow": {
        allowedCommands.set(decisionKey, 1);
        stats.allowed++;
        updateStatus(ctx);
        return; // Let the command run
      }

      case "allow-rule": {
        allowedRules.add(match.rule.id);
        stats.allowed++;
        updateStatus(ctx);
        return; // Let the command run, and stop prompting for this rule
      }

      case "edit": {
        const replacement = await askForText(
          ctx,
          `Replacement for: ${command}`,
          command,
        );

        if (!replacement || replacement.trim().length === 0) {
          stats.blocked++;
          updateStatus(ctx);
          return { block: true, reason: "Command guard: blocked (no replacement provided)" };
        }

        const trimmed = replacement.trim();

        if (trimmed.length > analysisLimit) {
          stats.blocked++;
          updateStatus(ctx);
          return {
            block: true,
            reason: "Command guard: blocked (replacement command too long to analyze)",
          };
        }

        // Fail-closed: a replacement that still matches a rule is not run.
        const replacementMatch = matchCommand(trimmed);
        if (replacementMatch) {
          ctx.ui.notify(
            `Replacement still matches "${replacementMatch.rule.label}"; original command not run.`,
            "warning",
          );
          stats.blocked++;
          updateStatus(ctx);
          return {
            block: true,
            reason: `Command guard: replacement still matches ${replacementMatch.rule.label}`,
          };
        }

        // Patch the tool arguments in place, then let the edited command run.
        event.input.command = trimmed;
        stats.allowed++;
        updateStatus(ctx);
        return;
      }

      case "block": {
        blockedCommands.set(decisionKey, 1);
        stats.blocked++;
        updateStatus(ctx);
        return { block: true, reason: "Command guard: blocked by user" };
      }

      case "custom": {
        const customText = await askForText(ctx, "Custom Instructions", "");

        if (customText && customText.trim().length > 0) {
          pi.sendMessage(
            {
              customType: "command-guard",
              content: [
                {
                  type: "text",
                  text: [
                    `⚠️ **Command Guard: Blocked Command**`,
                    ``,
                    `The user wanted to run this command:`,
                    `\`\`\``,
                    `${command}`,
                    `\`\`\``,
                    ``,
                    `**Why it was flagged:** ${match.rule.explanation}`,
                    ``,
                    `**Your instructions:** "${customText.trim()}"`,
                    ``,
                    `Please find a safer way to accomplish what the user wants. Suggest an alternative command or approach that achieves the same goal without the risks.`,
                  ].join("\n"),
                },
              ],
              display: true,
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        }

        stats.blocked++;
        updateStatus(ctx);
        return { block: true, reason: "Command guard: blocked" };
      }

      default: {
        // Fail-safe: an unrecognized decision must never let the command run.
        stats.blocked++;
        updateStatus(ctx);
        return { block: true, reason: "Command guard: blocked (unrecognized decision)" };
      }
    }
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Keep the footer status line in step with this session's guard decisions. */
  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "command-guard",
      `guard: ${stats.blocked} blocked · ${stats.allowed} allowed · ${stats.prompts} prompts`,
    );
  }

  async function showGuardDialog(
    match: MatchResult,
    command: string,
    ctx: ExtensionContext,
    timeoutMs: number,
  ): Promise<GuardDialogResult | null> {
    const params = {
      command,
      explanation: match.rule.explanation,
      ruleLabel: match.rule.label,
      severity: match.rule.severity,
      matchedText: match.matchedText,
      pendingCount: pendingDialogs + 1,
      timeoutMs,
    };

    pendingDialogs++;
    stats.prompts++;
    updateStatus(ctx);
    try {
      return await ctx.ui.custom<GuardDialogResult>(
        createGuardDialog(params),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: 76, maxHeight: 24 },
        },
      );
    } finally {
      pendingDialogs--;
    }
  }

  async function askForText(
    ctx: ExtensionContext,
    title: string,
    defaultValue: string,
  ): Promise<string | null> {
    return await ctx.ui.custom<string | null>(
      createInputDialog(title, defaultValue),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: 76, maxHeight: 12 },
      },
    );
  }
}
