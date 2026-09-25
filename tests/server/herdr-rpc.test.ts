import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrRpcTransport } from "../../server/herdr-rpc-transport.js";
import { HerdrWorkerRegistry } from "../../server/herdr-worker-registry.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";

const roots: string[] = [];
const workers: PiRpcProcess[] = [];
const bridges: ChildProcess[] = [];

async function processCanRun(pid: number): Promise<boolean> {
  try {
    const source = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(
      source.slice(source.lastIndexOf(")") + 2, -1).split(" ")[0]!,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "inspire-herdr-rpc-test-"));
  roots.push(root);
  const cliPath = join(root, "fake-pi.mjs");
  await writeFile(
    cliPath,
    String.raw`
import { appendFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
setInterval(() => appendFileSync(process.env.WRITER_FILE, '.'), 10);
process.stderr.write('native stderr sentinel\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    const command = JSON.parse(input.slice(0, end));
    input = input.slice(end + 1);
    if (command.type === 'wait') continue;
    const data = command.type === 'echo' ? command.value : {
      pid: process.pid,
      parent: process.ppid,
      pane: process.env.HERDR_PANE_ID,
      session: process.env.HERDR_SESSION,
      userExport: process.env.USER_EXPORT,
      nodeEnv: process.env.NODE_ENV ?? null,
      privateToken: process.env.USER_EXTENSION_TOKEN,
    };
    process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }) + '\n');
  }
});
`,
  );
  const registry = new HerdrWorkerRegistry(join(root, "leases"));
  let bridge: ChildProcess | null = null;
  const client = {
    createWorkerPane: vi.fn(
      async (_cwd: string, _label: string, argv: string[]) => {
        bridge = spawn(argv[0]!, argv.slice(1), {
          cwd: root,
          env: {
            ...process.env,
            HERDR_PANE_ID: "owned-pane",
            HERDR_SESSION: "real-session",
            NODE_ENV: "bridge-environment",
          },
          detached: true,
          stdio: "ignore",
        });
        bridges.push(bridge);
        await new Promise<void>((resolve, reject) => {
          bridge!.once("spawn", resolve);
          bridge!.once("error", reject);
        });
        return {
          serverId: "owned-server",
          paneId: "owned-pane",
          workspaceId: "owned-workspace",
          tabId: "owned-tab",
        };
      },
    ),
    closePane: vi.fn(async () => {}),
  };
  let transport: HerdrRpcTransport;
  const rpc = new PiRpcProcess({
    cwd: root,
    cliPath,
    env: {
      WRITER_FILE: join(root, "writes"),
      USER_EXPORT: "user-owned-value",
      NODE_ENV: undefined,
      HERDR_PANE_ID: "wrong-parent-pane",
      HERDR_SESSION: "wrong-parent-session",
      USER_EXTENSION_TOKEN: "private-worker-capability",
    },
    createTransport: (launch) =>
      (transport = new HerdrRpcTransport(launch, {
        registry,
        client,
        label: "Pi",
      })),
  });
  workers.push(rpc);
  return {
    root,
    rpc,
    registry,
    client,
    getBridge: () => bridge!,
    getTransport: () => transport,
  };
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  for (const bridge of bridges.splice(0)) {
    if (bridge.exitCode === null && bridge.signalCode === null && bridge.pid) {
      try {
        process.kill(-bridge.pid, "SIGKILL");
      } catch {}
    }
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "linux")("Herdr RPC transport", () => {
  it("preserves RPC bytes, the user environment and real pane identity without exposing capabilities in argv", async () => {
    const { rpc, registry, client, getBridge } = await harness();
    await rpc.start();
    const state = await rpc.request<Record<string, unknown>>({
      type: "get_state",
    });
    expect(state).toMatchObject({
      parent: getBridge().pid,
      pane: "owned-pane",
      session: "real-session",
      userExport: "user-owned-value",
      nodeEnv: null,
      privateToken: "private-worker-capability",
    });
    expect(rpc.pid).toBe(state.pid);
    const value = `left\u2028right\n${"x".repeat(1024 * 1024)}`;
    await expect(rpc.request({ type: "echo", value })).resolves.toBe(value);
    expect(client.createWorkerPane.mock.calls[0]?.[2].join(" ")).not.toContain(
      "private-worker-capability",
    );
    const leases = await registry.list();
    expect(leases).toHaveLength(1);
    expect(leases[0]?.group?.pid).toBe(getBridge().pid);
    await rpc.stop();
    expect(await processCanRun(Number(state.pid))).toBe(false);
    expect(await registry.list()).toEqual([]);
    expect(client.closePane).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "owned-server",
        paneId: "owned-pane",
      }),
    );
  });

  it("fences a writer that ignores TERM after its bridge is killed", async () => {
    const { rpc, getBridge, registry } = await harness();
    await rpc.start();
    const pid = rpc.pid!;
    const pending = rpc
      .request({ type: "wait" }, null)
      .catch((error: Error) => error);
    const retired = new Promise<void>((resolve) =>
      rpc.once("exit", () => resolve()),
    );
    getBridge().kill("SIGKILL");
    await retired;
    await rpc.stop();
    expect(await processCanRun(pid)).toBe(false);
    expect(await pending).toBeInstanceOf(Error);
    expect(await registry.list()).toEqual([]);
  });

  it("waits for allocation ownership even when the bridge connects before it is recorded", async () => {
    const { rpc, root, registry, getTransport } = await harness();
    let entered!: () => void;
    const creating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = registry.create.bind(registry);
    vi.spyOn(registry, "create").mockImplementation(async (...args) => {
      entered();
      await held;
      return create(...args);
    });
    const starting = rpc.start();
    await creating;
    try {
      await vi.waitFor(() => {
        expect(getTransport()).toHaveProperty("rpc", expect.anything());
        expect(getTransport()).toHaveProperty("errors", expect.anything());
      });
      await expect(readFile(join(root, "writes"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      release();
    }
    await starting;
    expect(rpc.pid).toBeGreaterThan(1);
  });

  it("does not grant Pi launch when stop races persisted ownership", async () => {
    const { rpc, root, registry } = await harness();
    let grantEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      grantEntered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const grant = registry.grant.bind(registry);
    vi.spyOn(registry, "grant").mockImplementation(async (lease, group) => {
      grantEntered();
      await held;
      return grant(lease, group);
    });
    const starting = rpc.start().catch((error: Error) => error);
    await entered;
    const stopping = rpc.stop();
    release();
    await stopping;
    expect(await starting).toBeInstanceOf(Error);
    await expect(readFile(join(root, "writes"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await registry.list()).toEqual([]);
  });
});
