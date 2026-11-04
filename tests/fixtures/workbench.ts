import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import type { AttachmentStore } from "../../server/attachments.js";
import { isolatedTestEnvironment } from "../server/fixtures/isolated-environment.js";
import { hostServices } from "./host-services.js";
import { seedWorkbenchSessions } from "./workbench-sessions.js";

/** Configure a disposable real Pi workspace with a deterministic offline provider. */
export async function workbenchFixture(
  root: string,
  options: {
    cwd?: string;
    attachments?: AttachmentStore;
    seed?: boolean;
    rich?: boolean;
    image?: string;
    streamIntervalMs?: number;
  } = {},
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
  const services = hostServices(root, {
    cwd,
    attachments: options.attachments,
    createProcess: (options) =>
      new PiRpcProcess({
        ...options,
        env: { ...env, ...options.env },
        args: [
          "--no-skills",
          "--no-context-files",
          "--no-prompt-templates",
          "--no-themes",
          "--no-tools",
          "--no-approve",
          ...(options.args ?? []),
        ],
      }),
  });
  return { root, cwd, agent, sessions, env, ...services };
}
