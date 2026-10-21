import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type ModelOption,
  type NewSessionDefaults,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../shared/contracts.js";
import {
  createAgentSession,
  DefaultResourceLoader,
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
    !hasTrustRequiringProjectResources(cwd) ||
      (new ProjectTrustStore(agentDir).get(cwd) ??
        settings.getDefaultProjectTrust() === "always"),
  );
  return settings;
}

/** Same precedence as AgentSession.setModel, before capability clamping. It
 * reads public settings only, including for extension-only model identities. */
export function modelSwitchThinkingLevel(
  cwd: string,
  provider: string,
  id: string,
  current: ThinkingLevel,
): ThinkingLevel {
  const settings = modelSettings(cwd);
  return (
    settings.getModelThinkingLevel(provider, id) ??
    settings.getDefaultThinkingLevel() ??
    current
  );
}

/** Resolve the model Pi will choose when Inspire omits `--model` for this
 * workspace. Pi's public SDK owns saved-default, auth, provider-default, and
 * first-available fallback behavior; the host only applies Pi CLI's public
 * enabled-model scope before asking the SDK for the final startup state. */
export async function resolveNewSessionDefaults(
  runtime: ModelRuntime,
  cwd: string,
  settings = modelSettings(cwd),
): Promise<NewSessionDefaults> {
  const agentDir = getAgentDir();
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

  // Registrations are already bound to this runtime by the metadata bootstrap.
  // Resolve with no second extension load or persistent session.
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
  const thinkingLevel = session.thinkingLevel;
  session.dispose();
  return {
    cwd,
    model: defaultModelOption(model),
    thinkingLevel,
  };
}
