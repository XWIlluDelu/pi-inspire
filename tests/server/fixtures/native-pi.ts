import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import { PiRpcProcess } from "../../../server/pi-rpc.js";
import { newBridgeIdentity } from "../../../server/runtime-branch-bridge.js";
import { isolatedTestEnvironment } from "./isolated-environment.js";

/** One offline native Pi workspace, with no credentials or user configuration. */
export async function nativePiWorkspace(
  prefix: string,
  settings: Record<string, unknown>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const agent = join(root, "agent");
  const cwd = join(root, "workspace");
  const sessions = join(root, "sessions");
  await Promise.all([agent, cwd, sessions].map((path) => mkdir(path)));
  await writeFile(join(agent, "auth.json"), "{}");
  await writeFile(join(agent, "settings.json"), JSON.stringify(settings));
  return { root, agent, cwd, sessions, env: isolatedTestEnvironment(root) };
}

/** SDK calls in the Host use the same fixture directories as its child. */
export function stubNativePiEnvironment(environment: NodeJS.ProcessEnv) {
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && key.toLowerCase() !== "path")
      vi.stubEnv(key, value);
  }
}

export function nativeBridgeWorker(
  workspace: Awaited<ReturnType<typeof nativePiWorkspace>>,
  extension: string,
) {
  const bridge = newBridgeIdentity();
  const rpc = new PiRpcProcess({
    cwd: workspace.cwd,
    env: {
      ...workspace.env,
      INSPIRE_BRANCH_COMMAND: bridge.command,
      INSPIRE_BRANCH_STATUS_KEY: bridge.statusKey,
      INSPIRE_BRANCH_WORKER_ID: bridge.workerId,
    },
    args: [
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--no-tools",
      "--no-approve",
      "--extension",
      resolve("server/extensions/inspire-branch-bridge.ts"),
      "--extension",
      resolve(extension),
    ],
  });
  return { bridge, rpc };
}
