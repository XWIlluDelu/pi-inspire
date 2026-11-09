import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isolatedTestEnvironment } from "../server/fixtures/isolated-environment.js";
import { seedWorkbenchSessions } from "./workbench-sessions.js";

export interface WorkbenchEnvironmentOptions {
  cwd?: string;
  seed?: boolean;
  rich?: boolean;
  image?: string;
  streamIntervalMs?: number;
}

/** Prepare an offline Pi workspace before loading the Host that uses it. */
export async function prepareWorkbenchEnvironment(
  root: string,
  options: WorkbenchEnvironmentOptions = {},
) {
  const cwd = options.cwd ?? join(root, "workspace");
  const agent = join(root, "agent");
  const sessions = join(root, "sessions");
  await Promise.all(
    [cwd, agent, sessions].map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(
    join(agent, "auth.json"),
    JSON.stringify({ workbench: { type: "api_key", key: "synthetic" } }),
  );
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "workbench",
      defaultModel: "offline",
      defaultThinkingLevel: "medium",
      defaultProjectTrust: "always",
      enableInstallTelemetry: false,
      packages: [],
      extensions: [resolve("tests/fixtures/pi-workbench-provider.ts")],
      skills: [],
      prompts: [],
      retry: { enabled: false },
      compaction: { enabled: false },
      cacheWarming: "off",
    }),
  );
  if (options.seed !== false)
    await seedWorkbenchSessions(sessions, cwd, options.image, options.rich);
  const env = isolatedTestEnvironment(root, {
    INSPIRE_PI_COMMAND: process.env.INSPIRE_PI_COMMAND,
    INSPIRE_FIXTURE_STREAM_INTERVAL_MS: String(options.streamIntervalMs ?? 0),
  });
  return { root, cwd, agent, sessions, env };
}
