import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectTrustStore } from "../../../server/pi-runtime.js";
import { nativePiWorkspace, stubNativePiEnvironment } from "./native-pi.js";

export async function modelWorkflowFixture() {
  const workspace = await nativePiWorkspace("inspire-model-workflow-", {});
  const { root, agent, sessions } = workspace;
  const events = join(root, "events");
  stubNativePiEnvironment({
    ...workspace.env,
    INSPIRE_MODEL_FIXTURE_EVENTS: events,
  });
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      extensions: [resolve("tests/fixtures/pi-model-workflow-extension.ts")],
      defaultProvider: "global-router",
      defaultModel: "auto",
      defaultThinkingLevel: "high",
      defaultProjectTrust: "ask",
      compaction: { enabled: false },
      cacheWarming: "off",
      retry: { enabled: false },
      enableInstallTelemetry: false,
    }),
  );
  const trusted = join(root, "trusted");
  const untrusted = join(root, "untrusted");
  for (const cwd of [trusted, untrusted]) {
    await mkdir(join(cwd, ".pi/extensions"), { recursive: true });
    await writeFile(
      join(cwd, ".pi/extensions/project.ts"),
      `import { registerModelWorkflow } from ${JSON.stringify(pathToFileURL(resolve("tests/fixtures/pi-model-workflow-extension.ts")).href)}; export default pi => registerModelWorkflow(pi, "project");`,
    );
    await writeFile(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({
        defaultProvider: "project-router",
        defaultModel: "auto",
        defaultThinkingLevel: "low",
      }),
    );
  }
  new ProjectTrustStore(agent).set(trusted, true);
  return { root, agent, sessions, events, trusted, untrusted };
}
