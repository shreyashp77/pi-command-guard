import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

// ─── Result types ────────────────────────────────────────────────────────────

export type GuardChoice = "allow" | "block" | "custom";

export interface GuardDialogResult {
  choice: GuardChoice;
  customInstructions?: string;
}

// ─── Guard Dialog Factory ────────────────────────────────────────────────────

export interface GuardDialogParams {
  command: string;
  explanation: string;
  ruleLabel: string;
}

export function createGuardDialog(
  params: GuardDialogParams,
): (tui: any, theme: any, _kb: any, done: (result: GuardDialogResult | null) => void) => any {
  return (_tui, theme, _kb, done) => {
    const container = new Container();

    // Top border
    container.addChild(
      new DynamicBorder((s: string) => theme.fg("warning", s)),
    );

    // Title
    container.addChild(
      new Text(theme.fg("warning", theme.bold("⚠️  Command Blocked")) + " — " + theme.fg("muted", params.ruleLabel), 1, 0),
    );

    // Explanation
    const explanationLines = params.explanation.split("\n");
    for (const line of explanationLines) {
      container.addChild(new Text(theme.fg("text", line), 1, 0));
    }

    // Spacer
    container.addChild(new Text("", 0, 0));

    // Command display
    container.addChild(new Text(theme.fg("toolOutput", params.command), 1, 0));

    // Spacer
    container.addChild(new Text("", 0, 0));

    // Selection options
    const items: SelectItem[] = [
      { value: "allow", label: "Allow — Run this command", description: "Proceed with the original command" },
      { value: "block", label: "Block — Do not run", description: "Cancel this command" },
      { value: "custom", label: "Custom Instructions", description: "Tell the LLM what you want instead" },
    ];

    const selectList = new SelectList(items, Math.min(items.length, 5), {
      selectedPrefix: (t) => theme.fg("accent", "→ " + t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => {
      done({ choice: item.value as GuardChoice });
    };

    selectList.onCancel = () => {
      done(null);
    };

    container.addChild(selectList);

    // Help text
    container.addChild(
      new Text(theme.fg("dim", "↑↓ navigate  •  enter select  •  esc cancel"), 1, 0),
    );

    // Bottom border
    container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput?.(data);
        _tui.requestRender();
      },
    };
  };
}
