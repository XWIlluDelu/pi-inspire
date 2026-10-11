import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { nativePiWorkspace } from "./fixtures/native-pi.js";

const directories: string[] = [];
const workers: PiRpcProcess[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const workspace = await nativePiWorkspace("inspire-startup-diagnostics-", {
    enableInstallTelemetry: false,
    cacheWarming: "off",
  });
  directories.push(workspace.root);
  const start = (extraArgs: string[] = []) => {
    const rpc = new PiRpcProcess({
      cwd: workspace.cwd,
      env: workspace.env,
      args: [
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
        "--no-tools",
        ...extraArgs,
      ],
    });
    workers.push(rpc);
    return rpc;
  };
  return { ...workspace, start };
}

describe("native Pi startup diagnostics", () => {
  it("identifies a broken extension without publishing its exception body", async () => {
    const workspace = await fixture();
    const extension = join(workspace.root, "broken.ts");
    await writeFile(
      extension,
      'export default function () { throw new Error("private-native-token"); }',
    );
    const rpc = workspace.start(["--extension", extension]);
    const exit = new Promise<Error>((resolve) => rpc.once("exit", resolve));
    const failure = await rpc
      .start()
      .catch((error) => error as Error & { detail?: string });
    if (!(failure instanceof Error))
      throw new Error("Expected startup failure");
    expect(failure.message).toContain("Could not load Pi extension");
    expect(failure.message).toContain(extension);
    expect(failure.message).toContain("Repair or disable");
    expect(failure.message).not.toContain("private-native-token");
    expect(failure.detail).toContain("private-native-token");
    expect((await exit).message).toBe(failure.message);
    expect(rpc.available).toBe(false);
    expect(rpc.pid).toBeNull();
  }, 20_000);

  it("warns about malformed native settings even when the setter applies only in memory", async () => {
    const workspace = await fixture();
    const settingsPath = join(workspace.agent, "settings.json");
    const malformed = '{ "private-setting": ';
    await writeFile(settingsPath, malformed);
    const rpc = workspace.start();
    const events: Record<string, unknown>[] = [];
    rpc.on("event", (event) => events.push(event));
    await rpc.start();
    expect(events.filter((event) => event.method === "notify")).toEqual([
      expect.objectContaining({
        notifyType: "warning",
        message: expect.stringContaining(settingsPath),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private-setting");
    await rpc.request({ type: "set_auto_compaction", enabled: false });
    expect(await rpc.request({ type: "get_state" })).toMatchObject({
      autoCompactionEnabled: false,
    });
    await rpc.stop();
    expect(await readFile(settingsPath, "utf8")).toBe(malformed);
  }, 20_000);
});
