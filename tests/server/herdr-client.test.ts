import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrClient } from "../../server/herdr-client.js";
import { HerdrControl } from "../../server/herdr-control.js";

const fixture = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prefix = args[0] === '--session' ? args.splice(0, 2) : [];
const root = process.env.HERDR_FAKE_ROOT;
fs.appendFileSync(path.join(root, 'commands'), JSON.stringify({ prefix, args, sessionEnv: process.env.HERDR_SESSION, paneEnv: process.env.HERDR_PANE_ID }) + '\n');
const marker = path.join(root, 'running');
function output(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
if (args.join(' ') === 'status server --json') {
  const running = fs.existsSync(marker);
  output({ status: running ? 'running' : 'not_running', running, compatible: running ? process.env.HERDR_FAKE_INCOMPATIBLE !== '1' : null, version: running ? '0.9.1' : null, protocol: 22, socket: path.join(root, 'api.sock') });
} else if (args.join(' ') === 'status client --json') {
  output({ binary: process.argv[1] });
} else if (args.join(' ') === 'server') fs.writeFileSync(marker, 'running');
else process.exit(1);
`;

type LoggedCommand = {
  prefix: string[];
  args: string[];
  sessionEnv?: string;
  paneEnv?: string;
};
type LoggedRequest = { method: string; params: Record<string, unknown> };
const cleanups: (() => Promise<void>)[] = [];
const clients: HerdrClient[] = [];

async function harness(
  options: {
    running?: boolean;
    session?: string;
    environment?: NodeJS.ProcessEnv;
    failCreate?: boolean;
    failLayout?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "inspire-herdr-client-"));
  const binary = join(root, "fake-herdr.cjs");
  const address = join(root, "api.sock");
  await writeFile(binary, fixture);
  await chmod(binary, 0o755);
  if (options.running) await writeFile(join(root, "running"), "running");
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    HERDR_FAKE_ROOT: root,
    ...options.environment,
  };
  const client = new HerdrClient({
    binary,
    environment,
    session: options.session,
  });
  clients.push(client);
  const requests: LoggedRequest[] = [];
  const sockets = new Set<Socket>();
  let count = 0;
  const workspaces = new Map<string, Set<string>>();
  const tabs = new Map<string, { workspace: string; pane: string }>();
  const allocate = (workspace: string) => {
    const tab = `t${++count}`;
    const pane = `p${++count}`;
    tabs.set(tab, { workspace, pane });
    workspaces.get(workspace)!.add(pane);
    return { tab, pane };
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      socket.removeAllListeners("data");
      const { id, method, params } = JSON.parse(input.slice(0, newline));
      requests.push({ method, params });
      // Real Herdr serves exactly one request per control connection.
      const success = (result: unknown) =>
        socket.end(`${JSON.stringify({ id, result })}\n`);
      const failure = (code = "fixture_failure") =>
        socket.end(
          `${JSON.stringify({ id, error: { code, message: "fixture request failed" } })}\n`,
        );
      if (method === "ping")
        success({ type: "pong", protocol: 22, version: "0.9.1" });
      else if (method === "workspace.create") {
        if (options.failCreate) {
          failure();
          return;
        }
        const workspace = `w${++count}`;
        workspaces.set(workspace, new Set());
        const { tab, pane } = allocate(workspace);
        success({
          workspace: { workspace_id: workspace },
          tab: { tab_id: tab },
          root_pane: { pane_id: pane },
        });
      } else if (method === "workspace.close") {
        if (!workspaces.delete(params.workspace_id)) {
          failure("workspace_not_found");
          return;
        }
        for (const [id, tab] of tabs) {
          if (tab.workspace === params.workspace_id) tabs.delete(id);
        }
        success({});
      } else if (method === "layout.apply") {
        const previous = tabs.get(params.tab_id);
        const workspace = previous?.workspace ?? params.workspace_id;
        if (!workspaces.has(workspace)) {
          failure("workspace_not_found");
          return;
        }
        if (options.failLayout) {
          failure();
          return;
        }
        const { tab, pane } = allocate(workspace);
        if (previous) {
          workspaces.get(workspace)!.delete(previous.pane);
          tabs.delete(params.tab_id);
        }
        success({
          type: "layout_apply",
          layout: {
            workspace_id: workspace,
            tab_id: tab,
            root: { ...params.root, pane_id: pane },
          },
        });
      } else if (method === "pane.close") {
        const entry = [...tabs].find(([, tab]) => tab.pane === params.pane_id);
        if (!entry) {
          failure("pane_not_found");
          return;
        }
        const [tab, { workspace, pane }] = entry;
        tabs.delete(tab);
        workspaces.get(workspace)!.delete(pane);
        if (!workspaces.get(workspace)!.size) workspaces.delete(workspace);
        success({});
      } else failure();
    });
  });
  const listen = () =>
    new Promise<void>((resolve) => server.listen(address, resolve));
  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  await listen();
  cleanups.push(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  const restart = async () => {
    await stop();
    count = 0;
    workspaces.clear();
    tabs.clear();
    await listen();
  };
  const commands = async (): Promise<LoggedCommand[]> => {
    try {
      return (await readFile(join(root, "commands"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { client, root, binary, environment, commands, requests, restart };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const client of clients.splice(0)) client.close();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe.skipIf(process.platform !== "linux")("HerdrClient", () => {
  it("probes without starting or replacing an incompatible server", async () => {
    const missing = new HerdrClient({ binary: "/no-such-herdr-executable" });
    expect(await missing.probe()).toMatchObject({
      installed: false,
      running: false,
    });
    await expect(missing.ensureServer()).rejects.toThrow("not installed");
    const { client, root, commands, binary, environment } = await harness();
    expect(await client.probe()).toMatchObject({
      installed: true,
      running: false,
    });
    await writeFile(join(root, "running"), "running");
    expect(await client.probe()).toMatchObject({
      running: true,
      compatible: true,
      version: "0.9.1",
    });
    await client.ensureServer();
    const incompatible = new HerdrClient({
      binary,
      environment: { ...environment, HERDR_FAKE_INCOMPATIBLE: "1" },
    });
    await expect(incompatible.ensureServer()).rejects.toThrow("incompatible");
    expect(
      (await commands()).filter((item) => item.args.at(-1) === "server"),
    ).toHaveLength(0);
  });

  it("creates exact argv programs in no-focus project tabs without ambient Herdr identity or shell interpretation", async () => {
    const { client, commands, requests } = await harness({
      running: true,
      session: "isolated",
      environment: {
        HERDR_SESSION: "inherited",
        HERDR_SOCKET_PATH: "/wrong/socket",
        HERDR_PANE_ID: "foreign",
      },
    });
    const cwd = "/repo with spaces";
    const argv = ["/path/my pi", "a'b;$(touch bad)", "line\nbreak", ""];
    const [first, second, third] = await Promise.all([
      client.createWorkerPane(cwd, "one", argv),
      client.createWorkerPane(cwd, "two", ["pi"]),
      client.createWorkerPane(cwd, "three", ["pi"]),
    ]);
    expect(new Set([first.paneId, second.paneId, third.paneId]).size).toBe(3);
    expect(first.workspaceId).toBe(second.workspaceId);
    expect(second.workspaceId).toBe(third.workspaceId);
    expect(first.serverId).toBe(second.serverId);
    expect(
      requests.filter((item) =>
        ["workspace.create", "layout.apply"].includes(item.method),
      ),
    ).toEqual([
      {
        method: "workspace.create",
        params: { cwd, label: "one", focus: false },
      },
      {
        method: "layout.apply",
        params: {
          tab_id: expect.any(String),
          focus: false,
          root: { type: "pane", cwd, label: "one", command: argv },
        },
      },
      {
        method: "layout.apply",
        params: {
          workspace_id: first.workspaceId,
          focus: false,
          root: { type: "pane", cwd, label: "two", command: ["pi"] },
        },
      },
      {
        method: "layout.apply",
        params: {
          workspace_id: first.workspaceId,
          focus: false,
          root: { type: "pane", cwd, label: "three", command: ["pi"] },
        },
      },
    ]);
    expect(
      (await commands()).every(
        (item) =>
          item.prefix.join(" ") === "--session isolated" &&
          !item.sessionEnv &&
          !item.paneEnv,
      ),
    ).toBe(true);
    await expect(
      client.createWorkerPane(cwd, "invalid", ["pi", String.fromCharCode(0)]),
    ).rejects.toThrow("NUL");
  });

  it("does not retry ambiguous allocation; only exact private leases can restore cleanup ownership", async () => {
    const failed = await harness({ running: true, failCreate: true });
    const results = await Promise.allSettled([
      failed.client.createWorkerPane("/repo", "one", ["pi"]),
      failed.client.createWorkerPane("/repo", "two", ["pi"]),
    ]);
    expect(results.every((item) => item.status === "rejected")).toBe(true);
    expect(
      failed.requests.filter((item) => item.method === "workspace.create"),
    ).toHaveLength(1);
    const { client, requests, binary, environment } = await harness({
      running: true,
    });
    const first = await client.createWorkerPane("/repo", "one", ["pi"]);
    const second = await client.createWorkerPane("/repo", "two", ["pi"]);
    await expect(
      client.closePane({ ...first, paneId: "foreign" }),
    ).rejects.toThrow("not owned");
    await client.closePane(first);
    const recovered = new HerdrClient({ binary, environment });
    clients.push(recovered);
    recovered.restoreOwnedPane({ ...second, cwd: "/repo" });
    expect(() =>
      recovered.restoreOwnedPane({ ...second, cwd: "/repo" }),
    ).toThrow("ownership");
    await recovered.closePane(second);
    expect(
      requests
        .filter((item) => item.method === "pane.close")
        .map((item) => item.params.pane_id),
    ).toEqual([first.paneId, second.paneId]);
    await expect(recovered.closePane(second)).rejects.toThrow("not owned");
  });

  it("orders final-pane cleanup before creating the next project workspace", async () => {
    const { client, requests } = await harness({ running: true });
    const first = await client.createWorkerPane("/repo", "old", ["pi"]);
    const closing = client.closePane(first);
    const next = client.createWorkerPane("/repo", "new", ["pi"]);
    await closing;
    expect((await next).workspaceId).not.toBe(first.workspaceId);
    expect(
      requests
        .filter((item) => item.method !== "ping")
        .map((item) => item.method),
    ).toEqual([
      "workspace.create",
      "layout.apply",
      "pane.close",
      "workspace.create",
      "layout.apply",
    ]);
  });

  it.each([true, false])(
    "recreates an externally closed workspace (all workers retired: %s)",
    async (retireAll) => {
      const { client, root, requests } = await harness({ running: true });
      const first = await client.createWorkerPane("/repo", "first", ["pi"]);
      const second = await client.createWorkerPane("/repo", "second", ["pi"]);
      const external = await HerdrControl.open(join(root, "api.sock"), 22);
      try {
        await external.request("workspace.close", {
          workspace_id: first.workspaceId,
        });
      } finally {
        external.close();
      }
      await client.closePane(first);
      if (retireAll) await client.closePane(second);
      const next = await client.createWorkerPane("/repo", "new", ["pi"]);
      expect(next.workspaceId).not.toBe(first.workspaceId);
      if (!retireAll) await client.closePane(second);
      const sibling = await client.createWorkerPane("/repo", "sibling", ["pi"]);
      expect(sibling.workspaceId).toBe(next.workspaceId);
      expect(
        requests.filter(({ method }) => method === "workspace.create"),
      ).toHaveLength(2);
    },
  );

  it("does not replace a cached workspace after an uncertain layout failure", async () => {
    const options = { running: true, failLayout: false };
    const { client, requests } = await harness(options);
    await client.createWorkerPane("/repo", "first", ["pi"]);
    options.failLayout = true;
    await expect(
      client.createWorkerPane("/repo", "uncertain", ["pi"]),
    ).rejects.toThrow("fixture request failed");
    expect(
      requests.filter(({ method }) => method === "workspace.create"),
    ).toHaveLength(1);
    expect(
      requests.filter(({ method }) => method === "layout.apply"),
    ).toHaveLength(2);
  });

  it("never mutates a successor daemon's resources when its public IDs repeat", async () => {
    const { client, binary, environment, restart, requests } = await harness({
      running: true,
    });
    const old = await client.createWorkerPane("/repo", "old", ["pi"]);
    await restart();
    const current = new HerdrClient({ binary, environment });
    clients.push(current);
    const replacement = await current.createWorkerPane("/repo", "unrelated", [
      "pi",
    ]);
    expect(replacement.paneId).toBe(old.paneId);
    expect(replacement.serverId).not.toBe(old.serverId);
    const before = requests.length;
    await expect(
      client.createWorkerPane("/repo", "stale workspace", ["pi"]),
    ).rejects.toThrow("changed");
    const recovered = new HerdrClient({ binary, environment });
    clients.push(recovered);
    recovered.restoreOwnedPane({ ...old, cwd: "/repo" });
    await recovered.closePane(old);
    expect(
      requests.slice(before).filter((item) => item.method !== "ping"),
    ).toEqual([]);
  });

  it("detaches only outside a Host service and does not fall back after a transient user unit fails", async () => {
    vi.stubEnv("INVOCATION_ID", undefined);
    vi.stubEnv("SYSTEMD_EXEC_PID", undefined);
    const direct = await harness();
    await direct.client.ensureServer();
    expect(await direct.client.probe()).toMatchObject({
      running: true,
      compatible: true,
    });
    expect(
      (await direct.commands()).some(
        (item) => item.args.join(" ") === "server",
      ),
    ).toBe(true);
    // Host scope, not copied user exports, determines whether setsid suffices.
    vi.stubEnv("INVOCATION_ID", "service-test");
    const service = await harness();
    const fakeSystemdRun = join(service.root, "systemd-run");
    await writeFile(fakeSystemdRun, "#!/bin/sh\nexit 1\n");
    await chmod(fakeSystemdRun, 0o755);
    const systemdClient = new HerdrClient({
      binary: service.binary,
      environment: {
        ...service.environment,
        PATH: `${service.root}:${process.env.PATH}`,
      },
    });
    await expect(systemdClient.ensureServer()).rejects.toThrow();
    expect(
      (await service.commands()).some(
        (item) => item.args.join(" ") === "server",
      ),
    ).toBe(false);
  });
});
