import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ModelOption, type ThinkingLevel } from "../shared/contracts.js";

function thinkingLevelMap(value: unknown): ModelOption["thinkingLevelMap"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const entries = THINKING_LEVELS.flatMap((level) => {
    const mapped = source[level];
    return typeof mapped === "string" || mapped === null
      ? [[level, mapped] as [ThinkingLevel, string | null]]
      : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Read Pi's configured model authority and expose only picker metadata. */
export async function availableModelOptions(runtime: Pick<ModelRuntime, "getAvailable">): Promise<ModelOption[]> {
  const models = await runtime.getAvailable();
  return models.map((model) => {
    const map = thinkingLevelMap(model.thinkingLevelMap);
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      ...(map ? { thinkingLevelMap: map } : {}),
    };
  });
}
