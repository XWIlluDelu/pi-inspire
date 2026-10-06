import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";
import { ProjectTrustStore } from "../../../server/pi-runtime.js";

export async function modelWorkflowFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-model-workflow-")),
  );
  const agent = join(root, "agent");
  const sessions = join(root, "sessions");
  const events = join(root, "events");
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    INSPIRE_MODEL_FIXTURE_EVENTS: events,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  }))
    vi.stubEnv(key, value);
  await mkdir(agent, { recursive: true });
  await mkdir(sessions);
  await writeFile(join(agent, "auth.json"), "{}");
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
