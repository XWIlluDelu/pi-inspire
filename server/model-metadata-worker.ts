import { join } from "node:path";
import type { ThinkingLevel } from "../shared/contracts.js";
import {
  availableModelOptions,
  modelOption,
  modelSettings,
  modelSwitchThinkingLevel,
  resolveNewSessionDefaults,
} from "./model-catalog.js";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "./pi-runtime.js";

// A short-lived SDK process, not an RPC worker: no bindExtensions, session_start,
// prompt or persistent SessionManager. User factories still execute natively.
async function discover(cwd: string, validationPath?: string) {
  const agentDir = getAgentDir();
  const settings = modelSettings(cwd, agentDir);
  const runtime = await ModelRuntime.create({
    modelsPath: validationPath ?? join(agentDir, "models.json"),
    authPath: join(agentDir, "auth.json"),
    refreshOnCreate: false,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const extensionErrors = loader.getExtensions().errors.length > 0;
  // SDK initial resolution precedes constructor registration binding. This
  // disposable session binds Pi's queued providers/virtual models, then the
  // public resolver below sees the augmented runtime.
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  try {
    if (validationPath) {
      if (runtime.getError())
        throw new Error("Pi model configuration could not load");
      return null;
    }
    const refresh = await runtime.refresh({
      signal: AbortSignal.timeout(12_000),
    });
    if (runtime.getError())
      throw new Error("Pi model configuration could not load");
    const models = await availableModelOptions(runtime);
    const defaults = await resolveNewSessionDefaults(runtime, cwd, settings);
    const warnings: string[] = [];
    if (!settings.isProjectTrusted())
      warnings.push(
        "Project resources are not trusted; showing global models.",
      );
    if (extensionErrors)
      warnings.push(
        "Some Pi extensions could not load; their models may be unavailable.",
      );
    if (refresh.aborted || refresh.errors.size)
      warnings.push("Model refresh incomplete; showing Pi's available models.");
    return {
      models,
      enabledModelPatterns: settings.getEnabledModels() ?? [],
      // Use the same public registries as native get_commands, including Pi's
      // resolved invocation names for colliding extension commands.
      commands: [
        ...session.extensionRunner.getRegisteredCommands().map((command) => ({
          name: command.invocationName,
          description: command.description,
          source: "extension",
        })),
        ...session.promptTemplates.map((template) => ({
          name: template.name,
          description: template.description,
          source: "prompt",
        })),
        ...loader.getSkills().skills.map((skill) => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
        })),
      ],
      defaults,
      virtualModels: runtime
        .getModels()
        .filter((model) => model.api === "pi-virtual")
        .map(modelOption),
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  } finally {
    session.dispose();
  }
}

function readSettings(cwd: string) {
  const settings = modelSettings(cwd);
  const project = settings.getProjectSettings();
  const errors = settings.drainErrors();
  return {
    effective: {
      defaultProvider: settings.getDefaultProvider(),
      defaultModel: settings.getDefaultModel(),
      defaultThinkingLevel: settings.getDefaultThinkingLevel(),
      enabledModels: settings.getEnabledModels(),
    },
    projectOverrides: [
      "defaultProvider",
      "defaultModel",
      "defaultThinkingLevel",
      "enabledModels",
    ].filter((key) => Object.hasOwn(project, key)),
    globalError: errors.some(({ scope }) => scope === "global"),
    projectError: errors.some(({ scope }) => scope === "project"),
  };
}

// Keep the group leader alive until the parent retires the whole tree, including
// any factory-created descendants. IPC disconnect also retires an orphan query.
process.on("disconnect", () => process.exit(0));
try {
  const [, , cwd, mode, ...args] = process.argv;
  if (!cwd) throw new Error("Model worker workspace is required");
  const result =
    mode === "settings"
      ? readSettings(cwd)
      : mode === "thinking"
        ? modelSwitchThinkingLevel(
            cwd,
            args[0]!,
            args[1]!,
            args[2] as ThinkingLevel,
          )
        : await discover(cwd, mode === "validate" ? args[0] : undefined);
  process.send?.({ ok: true, result });
} catch {
  // Factory errors may contain credentials. Keep the wire result diagnostic-only.
  process.send?.({ ok: false });
}
