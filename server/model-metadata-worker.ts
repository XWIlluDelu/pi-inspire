import { join } from "node:path";
import {
  createModelPreview,
  defaultModelOption,
  modelOption,
  modelSettings,
  modelThinkingPreferences,
} from "./model-catalog.js";
import { modelQuerySchema } from "./model-metadata.js";
import {
  createAgentSession,
  createAgentSessionServices,
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
    ...(validationPath
      ? { modelsStorePath: join(agentDir, "models-store.json") }
      : {}),
    authPath: join(agentDir, "auth.json"),
    refreshOnCreate: false,
  });
  const resources = {
    cwd,
    agentDir,
    settingsManager: settings,
    noThemes: true,
    noContextFiles: true,
  };
  if (validationPath) {
    // The service factory waits for credential availability, which is not
    // part of a configuration edit. Register through Pi's in-memory session
    // without binding or waiting for an authentication probe.
    const loader = new DefaultResourceLoader(resources);
    await loader.reload();
    const { session } = await createAgentSession({
      ...resources,
      modelRuntime: runtime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "all",
    });
    try {
      if (runtime.getError())
        throw new Error("Pi model configuration could not load");
      return null;
    } finally {
      session.dispose();
    }
  }
  const services = await createAgentSessionServices({
    ...resources,
    modelRuntime: runtime,
    resourceLoaderOptions: { noThemes: true, noContextFiles: true },
  });

  const refresh = await runtime.refresh({
    signal: AbortSignal.timeout(12_000),
  });
  if (runtime.getError())
    throw new Error("Pi model configuration could not load");
  const { session } = await createModelPreview(services);
  try {
    const loader = services.resourceLoader;
    const models = (await runtime.getAvailable()).map(modelOption);
    const defaults = {
      cwd,
      model: defaultModelOption(session.model),
      thinkingLevel: session.thinkingLevel,
    };
    const warnings: string[] = [];
    if (!settings.isProjectTrusted())
      warnings.push(
        "Project resources are not trusted; showing global models.",
      );
    if (
      loader.getExtensions().errors.length ||
      services.diagnostics.some((diagnostic) => diagnostic.type === "error")
    )
      warnings.push(
        "Some Pi extensions could not load; their models may be unavailable.",
      );
    if (refresh.aborted || refresh.errors.size)
      warnings.push("Model refresh incomplete; showing Pi's available models.");
    return {
      models,
      enabledModelPatterns: settings.getEnabledModels() ?? [],
      thinkingPreferences: modelThinkingPreferences(settings),
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
  const thinkingPreferences = modelThinkingPreferences(settings);
  const effective = {
    defaultProvider: settings.getDefaultProvider(),
    defaultModel: settings.getDefaultModel(),
    defaultThinkingLevel: thinkingPreferences.defaultLevel,
    enabledModels: settings.getEnabledModels(),
  };
  return {
    effective,
    thinkingPreferences,
    projectOverrides: Object.keys(effective).filter((key) =>
      Object.hasOwn(project, key),
    ),
    globalError: errors.some(({ scope }) => scope === "global"),
    projectError: errors.some(({ scope }) => scope === "project"),
  };
}

// Keep the group leader alive until the parent retires the whole tree, including
// any factory-created descendants. IPC disconnect also retires an orphan query.
process.on("disconnect", () => process.exit(0));
try {
  const [, , cwd, raw] = process.argv;
  if (!cwd || !raw) throw new Error("Model worker query is required");
  const query = modelQuerySchema.parse(JSON.parse(raw));
  const result =
    query.kind === "settings"
      ? readSettings(cwd)
      : await discover(cwd, query.kind === "validate" ? query.path : undefined);
  process.send?.({ ok: true, result });
} catch {
  // Factory errors may contain credentials. Keep the wire result diagnostic-only.
  process.send?.({ ok: false });
}
