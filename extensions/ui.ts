import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

// ─── Result types ────────────────────────────────────────────────────────────

export type GuardChoice = "allow" | "allow-rule" | "edit" | "block" | "custom";

export interface GuardDialogResult {
  choice: GuardChoice;
  /** Set when the dialog expired on its own rather than being cancelled by the user. */
  timedOut?: boolean;
}

export interface GuardDialogParams {
  command: string;
  explanation: string;
  ruleLabel: string;
  severity: "critical" | "high" | "medium";
  /** Real matched fragment from the engine, highlighted inside the command when present. */
  matchedText?: string;
  /** How many guard dialogs are currently awaiting a decision. */
  pendingCount?: number;
  /** Dialog auto-resolves as a block after this many ms. */
  timeoutMs?: number;
}

// ─── Guard Dialog Factory ────────────────────────────────────────────────────

export function createGuardDialog(
  params: GuardDialogParams,
): (tui: any, theme: any, _kb: any, done: (result: GuardDialogResult | null) => void) => any {
  return (_tui, theme, _kb, done) => {
    let finished = false;
    let timer: any = null;

    const finish = (result: GuardDialogResult | null) => {
      if (finished) return;
      finished = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      done(result);
    };

    const container = new Container();
    const severityColor = params.severity === "medium" ? "accent" : "warning";

    // Top border
    container.addChild(
      new DynamicBorder((s: string) => theme.fg(severityColor, s)),
    );

    // Title
    container.addChild(
      new Text(
        theme.fg(severityColor, theme.bold("⚠️  Command Blocked")) +
          " — " +
          theme.fg("muted", params.ruleLabel) +
          (params.pendingCount && params.pendingCount > 1
            ? theme.fg("dim", `  (${params.pendingCount} commands awaiting review)`)
            : ""),
        1,
        0,
      ),
    );

    // Explanation
    for (const line of params.explanation.split("\n")) {
      container.addChild(new Text(theme.fg("text", line), 1, 0));
    }

    // Spacer
    container.addChild(new Text("", 0, 0));

    // Command display, with the matched fragment highlighted
    container.addChild(
      new Text(highlightCommand(params.command, params.matchedText, theme), 1, 0),
    );

    // Spacer
    container.addChild(new Text("", 0, 0));

    // Selection options
    const items: SelectItem[] = [
      {
        value: "allow",
        label: "Allow — run this command",
        description: "Proceed once; the same command will not prompt again this session",
      },
      {
        value: "allow-rule",
        label: `Allow ${params.ruleLabel} for the rest of this session`,
        description: "Skip the prompt for every command this rule matches",
      },
      {
        value: "edit",
        label: "Edit — run a replacement command",
        description: "Type a different command; the original is never run",
      },
      {
        value: "block",
        label: "Block — do not run",
        description: "Cancel this command",
      },
      {
        value: "custom",
        label: "Custom Instructions",
        description: "Tell the LLM what you actually want; the command stays blocked",
      },
    ];

    const selectList = new SelectList(items, Math.min(items.length, 5), {
      selectedPrefix: (t) => theme.fg("accent", "→ " + t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => {
      finish({ choice: item.value as GuardChoice });
    };

    selectList.onCancel = () => {
      finish(null);
    };

    container.addChild(selectList);

    // Help text, carrying the live countdown when a timeout is configured
    const helpText = new Text(helpLine(params.timeoutMs, theme), 1, 0);
    container.addChild(helpText);

    // Bottom border
    container.addChild(
      new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
    );

    if (params.timeoutMs && params.timeoutMs > 0) {
      const deadline = Date.now() + params.timeoutMs;
      timer = setInterval(() => {
        if (finished) return;
        const remaining = Math.ceil((deadline - Date.now()) / 1000);
        if (remaining <= 0) {
          finish({ choice: "block", timedOut: true });
          return;
        }
        helpText.content = helpLine(remaining * 1000, theme);
        _tui.requestRender();
      }, 1000);
    }

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput?.(data);
        _tui.requestRender();
      },
      dispose: () => {
        if (timer) clearInterval(timer);
        timer = null;
      },
    };
  };
}

/** One-line footer: navigation hints plus the remaining time before auto-block. */
function helpLine(timeoutMs: number | undefined, theme: any): string {
  const hints = "↑↓ navigate  •  enter select  •  esc cancel";
  if (!timeoutMs || timeoutMs <= 0) return theme.fg("dim", hints);
  const seconds = Math.ceil(timeoutMs / 1000);
  return theme.fg("dim", hints) + "  " + theme.fg("warning", `auto-blocks in ${seconds}s`);
}

/** Paint the matched fragment in the warning colour inside the command text. */
function highlightCommand(command: string, fragment: string | undefined, theme: any): string {
  if (!fragment || !command.includes(fragment)) return theme.fg("toolOutput", command);
  const index = command.indexOf(fragment);
  const before = command.slice(0, index);
  const after = command.slice(index + fragment.length);
  return (
    theme.fg("toolOutput", before) +
    theme.fg("warning", fragment) +
    theme.fg("toolOutput", after)
  );
}

// ─── Simple Text Input Dialog ────────────────────────────────────────────────

export function createInputDialog(
  title: string,
  defaultValue: string,
): (tui: any, theme: any, _kb: any, done: (result: string | null) => void) => any {
  return (_tui, theme, _kb, done) => {
    let text = defaultValue;

    const container = new Container();

    // Top border
    container.addChild(
      new DynamicBorder((s: string) => theme.fg("accent", s)),
    );

    // Title
    container.addChild(
      new Text(theme.fg("accent", theme.bold(title)), 1, 0),
    );

    // Spacer
    container.addChild(new Text("", 0, 0));

    // Input line: label + text field
    const inputText = new Text(
      theme.fg("text", "Enter instructions: ") + theme.fg("toolOutput", text),
      1,
      0,
    );
    container.addChild(inputText);

    // Spacer
    container.addChild(new Text("", 0, 0));

    // Help text
    container.addChild(
      new Text(theme.fg("dim", "Type your instructions  •  enter to confirm  •  esc to cancel"), 1, 0),
    );

    // Bottom border
    container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "\r" || data === "\n") {
          done(text.trim().length > 0 ? text.trim() : null);
        } else if (data === "\x1b" || data === "\x04") {
          done(null);
        } else if (data === "\b" || data === "\x7f") {
          text = text.slice(0, -1);
          inputText.content =
            theme.fg("text", "Enter instructions: ") + theme.fg("toolOutput", text);
          _tui.requestRender();
        } else if (data.length === 1) {
          text += data;
          inputText.content =
            theme.fg("text", "Enter instructions: ") + theme.fg("toolOutput", text);
          _tui.requestRender();
        }
      },
    };
  };
}

// ─── Static info panel (used by the /guard command) ─────────────────────────

export function createInfoPanel(
  title: string,
  lines: string[],
): (tui: any, theme: any, _kb: any, done: (result: null) => void) => any {
  return (_tui, theme, _kb, done) => {
    let closed = false;

    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Text("", 0, 0));
    for (const line of lines) {
      container.addChild(new Text(theme.fg("text", line), 1, 0));
    }
    container.addChild(new Text(theme.fg("dim", "enter to close"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (closed) return;
        if (data === "\r" || data === "\n" || data === "\x1b" || data === "\x04") {
          closed = true;
          done(null);
        }
      },
    };
  };
}

// ─── Transcript renderer for the injected guard message ──────────────────────
// pi renders a CustomMessage with a registered renderer; without one the injected
// "command guard" context falls back to default styling.

export function createGuardMessageRenderer(): (message: any, options: any, theme: any) => any {
  return (message, options, theme) => {
    const content = typeof message.content === "string"
      ? message.content
      : (message.content as any[])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");

    const container = new Container();
    container.addChild(
      new DynamicBorder((s: string) => theme.fg("warning", s)),
    );
    for (const line of content.split("\n")) {
      container.addChild(new Text(theme.fg("text", line), 1, 0));
    }
    container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
    };
  };
}
