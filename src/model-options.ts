import {
  type ModelOption,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../shared/contracts";

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
