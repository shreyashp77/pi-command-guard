import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, matchCommand } from "./patterns";
import { createGuardDialog, type GuardDialogResult } from "./ui";

export default function (pi: ExtensionAPI) {
  // ─── Session-local decision cache ─────────────────────────────────────────
  // Track commands the user allowed to avoid repeated prompts in the same session.
  interface DecisionEntry {
    command: string;
    decision: "allow" | "block";
    count: number;
  }
  const sessionDecisions: Map<string, DecisionEntry> = new Map();

  pi.on("session_start", async (_event, ctx) => {
    sessionDecisions.clear();
  });

  // ─── tool_call handler: intercept dangerous bash commands ─────────────────
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    if (typeof command !== "string" || command.trim().length === 0) return;

    // In non-interactive mode, block by default
    if (!ctx.hasUI) {
      return { block: true, reason: "Command guard: blocked (no UI for confirmation)" };
    }

    const match = matchCommand(command);
    if (!match) return;

    // Check session cache — skip prompt if user allowed this exact command recently
    const decisionKey = `${match.rule.id}:${command.trim()}`;
    const cachedDecision = sessionDecisions.get(decisionKey);
    if (cachedDecision?.decision === "allow" && cachedDecision.count > 0) {
      cachedDecision.count++;
      return; // Allow silently
    }

    // Show the guard dialog
    const result = await showGuardDialog(match, command, ctx);

    if (!result) {
      // User cancelled / dismissed via escape — block the command
      return { block: true, reason: "Command guard: blocked by user (cancelled)" };
    }

    switch (result.choice) {
      case "allow": {
        sessionDecisions.set(decisionKey, {
          command: command.trim(),
          decision: "allow",
          count: 1,
        });
        return; // Let the command run
      }

      case "block": {
        sessionDecisions.set(decisionKey, {
          command: command.trim(),
          decision: "block",
          count: 1,
        });
        return { block: true, reason: "Command guard: blocked by user" };
      }

      case "custom": {
        // Show input dialog for custom instructions
        const customText = await ctx.ui.input(
          "What do you want to do instead?",
          "",
        );

        if (customText && customText.trim().length > 0) {
          // Inject context message so the LLM can suggest a safer alternative
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

        return { block: true, reason: "Command guard: blocked" };
      }
    }
  });

  // ─── Helper: Show the guard dialog ────────────────────────────────────────

  async function showGuardDialog(
    match: ReturnType<typeof matchCommand>,
    command: string,
    ctx: Parameters<NonNullable<Parameters<ExtensionAPI["on"]>[1]>>[1],
  ): Promise<GuardDialogResult | null> {
    return new Promise<GuardDialogResult | null>((resolve) => {
      const params = {
        command,
        explanation: match.rule.explanation,
        ruleLabel: match.rule.label,
      };

      const componentFn = createGuardDialog(params);

      ctx.ui.custom(componentFn).then((result) => {
        resolve(result);
      });
    });
  }
}
