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
    getAgentDir,
    hasTrustRequiringProjectResources,
    InteractiveMode,
    ProjectTrustStore,
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
      // Use Pi's saved trust decision. Without a decision, do not load
      // project-local code that the stock CLI would ask the user to trust.
      const projectTrusted =
        trust.get(cwd) ?? !hasTrustRequiringProjectResources(cwd);
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager: SettingsManager.create(cwd, agentDir, {
          projectTrusted,
        }),
        modelRuntimeSignal: AbortSignal.timeout(15_000),
        resourceLoaderOptions: {
          extensionFactories: [
            {
              name: "inspire-attach-control",
              factory: attachControl,
              hidden: true,
            },
          ],
        },
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
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
