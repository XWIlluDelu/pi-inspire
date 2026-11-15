import type {
  AgentSessionServices,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  type ModelOption,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../shared/contracts.js";
import type { ModelThinkingPreferences } from "../shared/model-settings.js";
import {
  createAgentSessionFromServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
} from "./pi-runtime.js";

function thinkingLevelMap(value: unknown): ModelOption["thinkingLevelMap"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const source = value as Record<string, unknown>;
  const entries = THINKING_LEVELS.flatMap((level) => {
    const mapped = source[level];
    return typeof mapped === "string" || mapped === null
      ? [[level, mapped] as [ThinkingLevel, string | null]]
      : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

type PiModel = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  api?: string;
  virtual?: boolean;
  thinkingLevelMap?: unknown;
};

export function modelOption(model: PiModel): ModelOption {
  const map = thinkingLevelMap(model.thinkingLevelMap);
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.api === "pi-virtual" || model.virtual ? { virtual: true } : {}),
    ...(map ? { thinkingLevelMap: map } : {}),
  };
}

/** Pi represents an absent configured model as `unknown/unknown`. The browser
 * must receive that as no default instead of a selectable model that will
 * crash the first worker at startup. */
export function defaultModelOption(
  model: PiModel | null | undefined,
): ModelOption | null {
  if (!model || (model.provider === "unknown" && model.id === "unknown")) {
    return null;
  }
  return modelOption(model);
}

/** Read Pi's configured model authority and expose only picker metadata. */
export async function availableModelOptions(
  runtime: Pick<ModelRuntime, "getAvailable">,
): Promise<ModelOption[]> {
  return (await runtime.getAvailable()).map(modelOption);
}

/** Metadata reads never grant project trust. Native saved parent decisions and
 * the global non-interactive default determine which project settings load. */
export function modelSettings(cwd: string, agentDir = getAgentDir()) {
  const settings = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  settings.setProjectTrusted(
    new ProjectTrustStore(agentDir).get(cwd) ??
      (!hasTrustRequiringProjectResources(cwd) ||
        settings.getDefaultProjectTrust() === "always"),
  );
  return settings;
}

/** Project only model identities and supported levels from native settings. */
export function modelThinkingPreferences(
  settings: ReturnType<typeof modelSettings>,
): ModelThinkingPreferences {
  const defaultLevel = settings.getDefaultThinkingLevel();
  return {
    defaultLevel:
      defaultLevel && THINKING_LEVELS.includes(defaultLevel)
        ? defaultLevel
        : undefined,
    byModel: Object.fromEntries(
      Object.entries(settings.getAllModelThinkingLevels()).filter(
        ([identity, level]) =>
          identity.includes("/") && THINKING_LEVELS.includes(level),
      ),
    ),
  };
}

/** Build one native preview after the service factory has registered providers.
 * Use Pi CLI's enabled-model scope for the model/thinking defaults. */
export async function createModelPreview(services: AgentSessionServices) {
  const { modelRuntime, settingsManager, cwd } = services;
  const patterns = settingsManager.getEnabledModels() ?? [];
  const scoped = patterns.length
    ? (await resolveModelScopeWithDiagnostics(patterns, modelRuntime))
        .scopedModels
    : [];
  const selected =
    scoped.find(
      ({ model }) =>
        model.provider === settingsManager.getDefaultProvider() &&
        model.id === settingsManager.getDefaultModel(),
    ) ?? scoped[0];
  return createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
    model: selected?.model,
    thinkingLevel: selected?.thinkingLevel,
  });
}
