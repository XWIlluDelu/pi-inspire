import {
  ACTIVITY_FOLD_VISIBILITIES,
  type InspirePreferences,
  TOOL_VISIBILITY_PREFERENCES,
  VISIBILITY_PREFERENCES,
} from "../shared/contracts";

function preferenceOptions<const Value extends string>(
  values: readonly Value[],
  descriptions?: Record<Value, string>,
) {
  return values.map((value) => ({
    value,
    label:
      value === "dynamic"
        ? "Adaptive"
        : value[0]!.toUpperCase() + value.slice(1),
    ...(descriptions && { description: descriptions[value] }),
  }));
}

export const preferenceChoices = {
  theme: {
    label: "Theme",
    options: preferenceOptions(["light", "dark", "system"]),
  },
  contentTextSize: {
    settingsOnly: true,
    label: "Content text size",
    description: "Applies to messages, input, code and previews.",
    options: preferenceOptions(["compact", "comfortable", "large"]),
  },
  readingWidth: {
    settingsOnly: true,
    label: "Reading width",
    description: "Maximum width for messages and input.",
    options: preferenceOptions(["narrow", "comfortable", "wide"]),
  },
  projectDisplay: {
    settingsOnly: true,
    label: "Project location",
    description: "Project name or path in the workbench header.",
    options: [
      { value: "folder", label: "Folder name" },
      { value: "path", label: "Full path" },
    ],
  },
  desktopSendKey: {
    settingsOnly: true,
    label: "Send key",
    description: "Desktop shortcut. Return adds a new line on touch keyboards.",
    options: [
      { value: "enter", label: "Enter" },
      { value: "mod-enter", label: "Ctrl/⌘+Enter" },
    ],
  },
  palette: {
    label: "Color palette",
    paletteLabel: "Palette",
    options: [
      { value: "wisteria", label: "Wisteria" },
      { value: "hydrangea", label: "Hydrangea" },
      { value: "lycoris", label: "Lycoris" },
      { value: "chimonanthus", label: "Chimonanthus" },
      { value: "classic-jade", label: "Jade" },
      { value: "classic-amber", label: "Amber" },
      { value: "mono", label: "Carbon & Silicon" },
    ],
  },
  launch: {
    label: "On launch",
    options: [
      {
        value: "welcome",
        label: "Show welcome page",
        actionLabel: "show welcome",
      },
      {
        value: "continue",
        label: "Continue previous session",
        actionLabel: "continue previous session",
      },
    ],
  },
  thinkingVisibility: {
    label: "Reasoning detail",
    paletteLabel: "Reasoning details",
    description: "How much model thinking to show.",
    options: preferenceOptions(VISIBILITY_PREFERENCES, {
      dynamic: "Opens while the model is working and folds afterward.",
      expanded: "Shows reasoning text in open cards.",
      collapsed: "Shows reasoning summaries until opened.",
      hidden: "Hides reasoning cards.",
    }),
  },
  toolVisibility: {
    label: "Tool activity",
    description: "Detail shown for each tool call.",
    options: preferenceOptions(TOOL_VISIBILITY_PREFERENCES, {
      dynamic: "Opens active calls and folds completed calls into icons.",
      expanded: "Shows tool arguments and results in open cards.",
      compact: "Shows one closed row for each tool call.",
      collapsed: "Groups completed tool calls into icons.",
      hidden: "Hides tool calls.",
    }),
  },
  activityFoldVisibility: {
    label: "Activity groups",
    description: "How groups of reasoning and tool calls open.",
    options: preferenceOptions(ACTIVITY_FOLD_VISIBILITIES, {
      dynamic: "Opens during live activity and folds when it settles.",
      expanded: "Shows all steps in order.",
      compact: "Shows recent steps, with earlier steps one click away.",
      collapsed: "Shows the group header until opened.",
    }),
  },
} as const satisfies {
  [Key in keyof InspirePreferences]?: {
    label: string;
    description?: string;
    paletteLabel?: string;
    settingsOnly?: true;
    options: ReadonlyArray<{
      value: InspirePreferences[Key];
      label: string;
      actionLabel?: string;
      description?: string;
    }>;
  };
};
