import { THINKING_LEVELS, type ModelOption, type ThinkingLevel } from "../shared/contracts";

/** Mirrors Pi's official getSupportedThinkingLevels metadata rule without
 * importing its Node-oriented model runtime into the browser bundle. */
export function supportedThinkingLevels(model: ModelOption | null): ThinkingLevel[] {
  if (model?.reasoning === false) return ["off"];
  if (!model) return [...THINKING_LEVELS];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}
