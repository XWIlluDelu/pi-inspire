export type TerminalCursorStyle = "block" | "bar" | "underline";
export type TerminalBellMode = "off" | "visual" | "desktop";
export type TerminalShortcutMode = "workbench" | "shell";

export interface TerminalUiSettings {
  fontSize: number;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  screenReaderMode: boolean;
  pasteProtection: boolean;
  shortcutMode: TerminalShortcutMode;
  bell: TerminalBellMode;
  longTaskNotifications: boolean;
  longTaskThresholdSeconds: number;
  scrollbackRows: number;
}

export const DEFAULT_TERMINAL_UI_SETTINGS: TerminalUiSettings = {
  fontSize: 13,
  lineHeight: 1.2,
  cursorStyle: "block",
  cursorBlink: true,
  screenReaderMode: false,
  pasteProtection: true,
  shortcutMode: "workbench",
  bell: "visual",
  longTaskNotifications: false,
  longTaskThresholdSeconds: 10,
  scrollbackRows: 20_000,
};

const STORAGE_KEY = "inspire:terminal-ui-settings:v1";

function finiteRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

export function loadTerminalUiSettings(): TerminalUiSettings {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<TerminalUiSettings> | null;
    if (!parsed || typeof parsed !== "object")
      return { ...DEFAULT_TERMINAL_UI_SETTINGS };
    return {
      fontSize: finiteRange(parsed.fontSize, 10, 24)
        ? Math.round(parsed.fontSize)
        : DEFAULT_TERMINAL_UI_SETTINGS.fontSize,
      lineHeight: finiteRange(parsed.lineHeight, 1, 1.6)
        ? parsed.lineHeight
        : DEFAULT_TERMINAL_UI_SETTINGS.lineHeight,
      cursorStyle: ["block", "bar", "underline"].includes(
        parsed.cursorStyle ?? "",
      )
        ? (parsed.cursorStyle as TerminalCursorStyle)
        : DEFAULT_TERMINAL_UI_SETTINGS.cursorStyle,
      cursorBlink:
        typeof parsed.cursorBlink === "boolean"
          ? parsed.cursorBlink
          : DEFAULT_TERMINAL_UI_SETTINGS.cursorBlink,
      screenReaderMode:
        typeof parsed.screenReaderMode === "boolean"
          ? parsed.screenReaderMode
          : DEFAULT_TERMINAL_UI_SETTINGS.screenReaderMode,
      pasteProtection:
        typeof parsed.pasteProtection === "boolean"
          ? parsed.pasteProtection
          : DEFAULT_TERMINAL_UI_SETTINGS.pasteProtection,
      shortcutMode: parsed.shortcutMode === "shell" ? "shell" : "workbench",
      bell: ["off", "visual", "desktop"].includes(parsed.bell ?? "")
        ? (parsed.bell as TerminalBellMode)
        : DEFAULT_TERMINAL_UI_SETTINGS.bell,
      longTaskNotifications:
        typeof parsed.longTaskNotifications === "boolean"
          ? parsed.longTaskNotifications
          : DEFAULT_TERMINAL_UI_SETTINGS.longTaskNotifications,
      longTaskThresholdSeconds:
        finiteRange(parsed.longTaskThresholdSeconds, 3, 3_600) &&
        Number.isInteger(parsed.longTaskThresholdSeconds)
          ? parsed.longTaskThresholdSeconds
          : DEFAULT_TERMINAL_UI_SETTINGS.longTaskThresholdSeconds,
      scrollbackRows:
        finiteRange(parsed.scrollbackRows, 1_000, 100_000) &&
        Number.isInteger(parsed.scrollbackRows)
          ? parsed.scrollbackRows
          : DEFAULT_TERMINAL_UI_SETTINGS.scrollbackRows,
    };
  } catch {
    return { ...DEFAULT_TERMINAL_UI_SETTINGS };
  }
}

export function saveTerminalUiSettings(settings: TerminalUiSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Browser storage is optional; the active settings still apply in memory.
  }
}
