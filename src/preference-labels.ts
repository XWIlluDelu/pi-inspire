import {
  ACTIVITY_FOLD_VISIBILITIES,
  type InspirePreferences,
  TOOL_VISIBILITY_PREFERENCES,
  VISIBILITY_PREFERENCES,
} from "../shared/contracts";

function choices<Value extends string>(
  values: readonly Value[],
  label: (value: Value) => string = (value) =>
    value === "dynamic" ? "Adaptive" : value[0]!.toUpperCase() + value.slice(1),
) {
  return values.map((value) => ({ value, label: label(value) }));
}

export const preferenceChoices = {
  theme: {
    label: "Theme",
    options: choices(["light", "dark", "system"] as const),
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
    options: choices(VISIBILITY_PREFERENCES),
  },
  toolVisibility: {
    label: "Tool activity",
    description: "Detail shown for each tool call.",
    options: choices(TOOL_VISIBILITY_PREFERENCES),
  },
  activityFoldVisibility: {
    label: "Activity groups",
    options: choices(ACTIVITY_FOLD_VISIBILITIES).map((option) => ({
      ...option,
      description: {
        dynamic: "Opens with live activity and closes when it settles.",
        expanded: "Opens the first activity page.",
        compact: "Opens the latest activity page.",
        collapsed: "Shows the group summary until opened.",
      }[option.value],
    })),
  },
} as const satisfies {
  [Key in keyof InspirePreferences]?: {
    label: string;
    description?: string;
    paletteLabel?: string;
    options: ReadonlyArray<{
      value: InspirePreferences[Key];
      label: string;
      actionLabel?: string;
      description?: string;
    }>;
  };
};
