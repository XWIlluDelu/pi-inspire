import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrClient } from "../../server/herdr-client.js";
import { HerdrEnhancement } from "../../server/herdr-enhancement.js";
import {
  assertHerdrWorkerScopesAvailable,
  stopHerdrProcessGroup,
} from "../../server/herdr-process-group.js";
import { HerdrWorkerRegistry } from "../../server/herdr-worker-registry.js";
import { piInstallation } from "../../server/pi-runtime.js";

const require = createRequire(import.meta.url);
const supported =
  process.platform === "linux" &&
  (await assertHerdrWorkerScopesAvailable(process.env).then(
    () => true,
    () => false,
  ));
const fixtures: {
  root: string;
  host: ChildProcess;
  registry: HerdrWorkerRegistry;
}[] = [];

// Only the pane allocation API is a fixture. Host, bridge, installed Pi's Bash
// implementation, detached shells, and systemd/cgroup cleanup are real processes.
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "inspire-herdr-scope-test-"));
  await mkdir(join(root, "agent"));
  await writeFile(
    join(root, "agent", "settings.json"),
    JSON.stringify({
      defaultProjectTrust: "never",
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      enableInstallTelemetry: false,
    }),
  );
  const moduleUrl = (name: string) =>
    new URL(`../../server/${name}.ts`, import.meta.url).href;
  const source = `
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { PiRpcProcess } from ${JSON.stringify(moduleUrl("pi-rpc"))};
import { HerdrRpcTransport } from ${JSON.stringify(moduleUrl("herdr-rpc-transport"))};
import { HerdrWorkerRegistry } from ${JSON.stringify(moduleUrl("herdr-worker-registry"))};
const root = ${JSON.stringify(root)};
const registry = new HerdrWorkerRegistry(root + '/leases');
let bridge;
const rpc = new PiRpcProcess({
  cwd: root,
  cliPath: ${JSON.stringify(piInstallation.cliPath)},
  args: ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-session'],
  env: { HOME: root, PI_CODING_AGENT_DIR: root + '/agent', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
  createTransport(launch) {
    return new HerdrRpcTransport(launch, { registry, label: 'scope test', client: {
      async createWorkerPane(cwd, label, argv) {
        bridge = spawn(argv[0], argv.slice(1), { cwd, env: process.env, detached: true, stdio: 'ignore' });
        return { serverId: 'scope-test-server', workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' };
      },
      async closePane() {},
    }});
  },
});
process.on('message', async () => {
  await rpc.stop();
  process.send({ stopped: true });
  process.disconnect();
});
await rpc.start();
void rpc.request({ type: 'bash', command: ${JSON.stringify(`echo $$ > '${join(root, "tool.pid")}'; while :; do echo tick >> '${join(root, "writes")}'; sleep 0.05; done`)} }, null).catch(() => {});
let toolPid;
for (let i = 0; i < 200; i++) {
  try { toolPid = Number(await readFile(root + '/tool.pid', 'utf8')); break; } catch {}
  await delay(25);
}
if (!toolPid) throw new Error('Bash did not start');
process.send({ ready: true, piPid: rpc.pid, bridgePid: bridge.pid, toolPid });
`;
  const entry = join(root, "host.mjs");
  await writeFile(entry, source);
  const host = spawn(
    process.execPath,
    ["--import", pathToFileURL(require.resolve("tsx")).href, entry],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const registry = new HerdrWorkerRegistry(join(root, "leases"));
  fixtures.push({ root, host, registry });
  let stderr = "";
  host.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const ready = await new Promise<{
    piPid: number;
    bridgePid: number;
    toolPid: number;
  }>((resolve, reject) => {
    host.once("error", reject);
    host.once("exit", () =>
      reject(new Error(stderr || "Fixture Host exited before ready")),
    );
    host.once("message", (message) =>
      resolve(message as { piPid: number; bridgePid: number; toolPid: number }),
    );
  });
  return { root, host, registry, ...ready };
}

async function processCanRun(pid: number): Promise<boolean> {
  try {
    const source = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(
      source.slice(source.lastIndexOf(")") + 2).split(" ")[0]!,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertStopped(root: string, ...pids: number[]) {
  await vi.waitFor(
    async () => {
      for (const pid of pids) expect(await processCanRun(pid)).toBe(false);
    },
    { timeout: 5_000 },
  );
  const before = (await stat(join(root, "writes"))).size;
  await delay(200);
  expect((await stat(join(root, "writes"))).size).toBe(before);
}

afterEach(async () => {
  for (const { root, host, registry } of fixtures.splice(0)) {
    host.kill("SIGKILL");
    for (const lease of await registry.list()) {
      if (lease.group)
        await stopHerdrProcessGroup(lease.group, false, () => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe.skipIf(!supported)("Herdr real Pi detached Bash ownership", () => {
  it.each(["ordinary stop", "TERM escalation", "Pi SIGKILL", "bridge SIGKILL"])(
    "stops Bash after %s",
    async (mode) => {
      const { root, host, registry, piPid, bridgePid, toolPid } =
        await harness();
      // This is the actual failure mechanism, not an assumed shared process group.
      const toolStat = await readFile(`/proc/${toolPid}/stat`, "utf8");
      expect(
        Number(toolStat.slice(toolStat.lastIndexOf(")") + 2).split(" ")[2]),
      ).toBe(toolPid);
      expect(toolPid).not.toBe(bridgePid);
      if (mode === "TERM escalation" || mode === "bridge SIGKILL")
        process.kill(piPid, "SIGSTOP");
      if (mode === "Pi SIGKILL") process.kill(piPid, "SIGKILL");
      if (mode === "bridge SIGKILL") process.kill(bridgePid, "SIGKILL");
      const stopped = new Promise<void>((resolve) =>
        host.once("message", () => resolve()),
      );
      host.send({ stop: true });
      await stopped;
      await assertStopped(root, piPid, bridgePid, toolPid);
      expect(await registry.list()).toEqual([]);
    },
    20_000,
  );

  it.each([false, true])(
    "keeps ownership after Host crash (bridge blocked: %s)",
    async (blockBridge) => {
      const { root, host, registry, piPid, bridgePid, toolPid } =
        await harness();
      if (blockBridge) {
        process.kill(bridgePid, "SIGSTOP");
        process.kill(piPid, "SIGSTOP");
      }
      const exited = new Promise<void>((resolve) =>
        host.once("exit", () => resolve()),
      );
      host.kill("SIGKILL");
      await exited;
      if (!blockBridge) await assertStopped(root, piPid, bridgePid, toolPid);
      else expect(await processCanRun(toolPid)).toBe(true);
      const client = new HerdrClient({
        binary: "/this-test-must-not-run-herdr",
      });
      vi.spyOn(client, "closePane").mockResolvedValue();
      // Recovery must also work when enhancement is disabled on the new Host.
      const enhancement = new HerdrEnhancement({
        enabled: false,
        registry,
        client,
      });
      try {
        await enhancement.initialize();
        expect(enhancement.createProcess({ cwd: root }).pid).toBeNull();
        await assertStopped(root, piPid, bridgePid, toolPid);
        expect(await registry.list()).toEqual([]);
      } finally {
        await enhancement.close();
      }
    },
    20_000,
  );
});
