import { resolve } from "node:path";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { attachControlForSession } from "../extensions/attach-control.js";
import { piInstallation } from "./pi-installation.js";

const args = process.argv.slice(2);
if (
  (args.length !== 0 && (args.length !== 2 || args[0] !== "--session")) ||
  !process.stdin.isTTY ||
  !process.stdout.isTTY
) {
  console.error("Usage in a terminal: inspire pi [--session <session.jsonl>]");
  process.exitCode = 64;
} else {
  const {
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createCodemodeExtension,
    createMcpExtension,
    createToolSearchExtension,
    getAgentDir,
    hasTrustRequiringProjectResources,
    InteractiveMode,
    ProjectTrustStore,
    resolveModelScopeWithDiagnostics,
    SessionManager,
    SettingsManager,
  } = piInstallation.sdk;
  const agentDir = getAgentDir();
  const trust = new ProjectTrustStore(agentDir);
  const sessionManager = args[1]
    ? SessionManager.open(resolve(args[1]))
    : SessionManager.create(process.cwd());

  let runtime: AgentSessionRuntime;
  const attachControl = attachControlForSession(() => runtime.session);
  runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const settingsManager = SettingsManager.create(cwd, agentDir, {
        projectTrusted: false,
      });
      // A saved denial takes precedence. Without a saved decision honor Pi's
      // global default, and leave projects requiring a trust prompt untrusted.
      settingsManager.setProjectTrusted(
        trust.get(cwd) ??
          (!hasTrustRequiringProjectResources(cwd) ||
            settingsManager.getDefaultProjectTrust() === "always"),
      );
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        modelRuntimeSignal: AbortSignal.timeout(15_000),
        resourceLoaderOptions: {
          extensionFactories: [
            {
              name: "codemode",
              factory: createCodemodeExtension(),
              builtin: true,
              replaceable: true,
            },
            {
              name: "tool-search",
              factory: createToolSearchExtension(),
              builtin: true,
              replaceable: true,
            },
            {
              name: "mcp",
              factory: createMcpExtension(),
              builtin: true,
              replaceable: true,
            },
            {
              name: "inspire-attach-control",
              factory: attachControl,
              hidden: true,
            },
          ],
        },
      });
      const patterns = settingsManager.getEnabledModels() ?? [];
      const scoped = patterns.length
        ? (
            await resolveModelScopeWithDiagnostics(
              patterns,
              services.modelRuntime,
              { signal: AbortSignal.timeout(15_000) },
            )
          ).scopedModels
        : [];
      const initial = sessionManager.buildSessionContext().messages.length
        ? undefined
        : (scoped.find(
            ({ model }) =>
              model.provider === settingsManager.getDefaultProvider() &&
              model.id === settingsManager.getDefaultModel(),
          ) ?? scoped[0]);
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        scopedModels: scoped,
        model: initial?.model,
        thinkingLevel: initial?.thinkingLevel,
      });
      return { ...result, services, diagnostics: services.diagnostics };
    },
    { cwd: sessionManager.getCwd(), agentDir, sessionManager },
  );
  await new InteractiveMode(runtime, {
    startupDiagnostics: [...runtime.diagnostics],
    modelFallbackMessage: runtime.modelFallbackMessage,
  }).run();
}
