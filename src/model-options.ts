import {
  type ModelOption,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../shared/contracts";

/** Resolve metadata for the selected identity without changing the selection.
 * A refreshed catalog supersedes older snapshot metadata; absent entries retain
 * the runtime model so disconnected discovery cannot erase known capabilities. */
export function resolveModelMetadata(
  model: ModelOption | null,
  catalog: readonly ModelOption[],
): ModelOption | null {
  if (!model) return null;
  return (
    catalog.find(
      (entry) => entry.provider === model.provider && entry.id === model.id,
    ) ?? model
  );
}

/** One display label for native levels across selectors and read-only surfaces. */
export function thinkingLevelLabel(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function thinkingLevelOptions(levels: readonly ThinkingLevel[]) {
  return levels.map((value) => ({ value, label: thinkingLevelLabel(value) }));
}

/** Native clamp: search upward first, then downward, rather than selecting
 * the first supported level and unexpectedly disabling reasoning. */
export function clampThinkingLevel(
  model: ModelOption | null,
  level: ThinkingLevel,
): ThinkingLevel {
  const available = supportedThinkingLevels(model);
  if (available.includes(level)) return level;
  const index = THINKING_LEVELS.indexOf(level);
  return (
    [
      ...THINKING_LEVELS.slice(index),
      ...THINKING_LEVELS.slice(0, index).reverse(),
    ].find((candidate) => available.includes(candidate)) ??
    available[0] ??
    "off"
  );
}

/** Mirrors Pi's official metadata rule without importing its Node-oriented
 * model runtime into the browser bundle. */
export function supportedThinkingLevels(
  model: ModelOption | null,
): ThinkingLevel[] {
  if (model?.reasoning === false) return ["off"];
  if (!model) return [...THINKING_LEVELS];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}
