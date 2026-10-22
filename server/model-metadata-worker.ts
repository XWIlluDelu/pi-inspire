import { join } from "node:path";
import {
  availableModelOptions,
  modelOption,
  modelSettings,
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
    noSkills: true,
    noPromptTemplates: true,
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

// Keep the group leader alive until the parent retires the whole tree, including
// any factory-created descendants. IPC disconnect also retires an orphan query.
process.on("disconnect", () => process.exit(0));
try {
  const result = await discover(process.argv[2]!, process.argv[3]);
  process.send?.({ ok: true, result });
} catch {
  // Factory errors may contain credentials. Keep the wire result diagnostic-only.
  process.send?.({ ok: false });
}
