import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  THINKING_LEVELS,
  type ModelOption,
  type NewSessionDefaults,
  type ThinkingLevel,
} from "../shared/contracts.js";

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
  thinkingLevelMap?: unknown;
};

function modelOption(model: PiModel): ModelOption {
  const map = thinkingLevelMap(model.thinkingLevelMap);
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
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

/** Resolve the model Pi will choose when Inspire omits `--model` for this
 * workspace. Pi's public SDK owns saved-default, auth, provider-default, and
 * first-available fallback behavior; the host only applies Pi CLI's public
 * enabled-model scope before asking the SDK for the final startup state. */
export async function resolveNewSessionDefaults(
  runtime: ModelRuntime,
  cwd: string,
): Promise<NewSessionDefaults> {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(cwd, agentDir);
  const patterns = settings.getEnabledModels() ?? [];
  const scoped =
    patterns.length > 0
      ? (await resolveModelScopeWithDiagnostics(patterns, runtime)).scopedModels
      : [];
  const savedProvider = settings.getDefaultProvider();
  const savedModelId = settings.getDefaultModel();
  const selectedScope =
    scoped.length > 0
      ? (scoped.find(
          ({ model }) =>
            model.provider === savedProvider && model.id === savedModelId,
        ) ?? scoped[0])
      : undefined;

  // The resolver needs no project resources or persistent session. Suppressing
  // them keeps this read-only preflight from loading extensions twice or
  // creating a session file while retaining Pi's actual model resolver.
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    noTools: "all",
    ...(selectedScope ? { model: selectedScope.model } : {}),
    ...(selectedScope?.thinkingLevel
      ? { thinkingLevel: selectedScope.thinkingLevel }
      : {}),
  });
  const model = session.model;
  const thinkingLevel = THINKING_LEVELS.includes(
    session.thinkingLevel as ThinkingLevel,
  )
    ? (session.thinkingLevel as ThinkingLevel)
    : "off";
  return {
    cwd,
    model: defaultModelOption(model),
    thinkingLevel,
  };
}
