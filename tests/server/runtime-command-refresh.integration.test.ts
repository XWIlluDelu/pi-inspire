import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { piInstallation } from "../../server/pi-runtime.js";
import { RuntimeController } from "../../server/runtime.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";

it("discovers and admits native in-process reload commands without replacing either worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspire-command-refresh-"));
  const agent = join(root, "agent");
  const cwd = join(root, "workspace");
  const sessions = join(root, "sessions");
  const prompts = join(agent, "prompts");
  await Promise.all(
    [cwd, sessions, prompts].map((path) => mkdir(path, { recursive: true })),
  );
  const environment = {
    HOME: root,
    USERPROFILE: root,
    PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
  await writeFile(join(agent, "auth.json"), "{}");
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      defaultProjectTrust: "never",
      compaction: { enabled: false },
      retry: { enabled: false },
      packages: [],
    }),
  );
  const extension = join(root, "reload.ts");
  await writeFile(
    extension,
    `export default function (pi) {
    pi.registerCommand("reload-fixture", {
      handler: async (_argument, ctx) => { await ctx.reload(); }
    });
    pi.on("input", (event, ctx) => {
      ctx.ui.notify("handled:" + event.text, "info");
      return { action: "handled" };
    });
  }`,
  );
  await writeFile(join(prompts, "removed.md"), "REMOVED_TEMPLATE");
  const records: SessionRecord[] = [];
  for (let index = 0; index < 2; index += 1) {
    const id = randomUUID();
    const path = join(sessions, `${id}.jsonl`);
    const timestamp = Date.now();
    await writeFile(
      path,
      [
        {
          type: "session",
          version: 3,
          id,
          timestamp: new Date(timestamp).toISOString(),
          cwd,
        },
        {
          type: "message",
          id: "00000001",
          parentId: null,
          timestamp: new Date(timestamp).toISOString(),
          message: {
            role: "user",
            content: "Retained conversation",
            timestamp,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    records.push({
      id,
      path,
      cwd,
      source: null,
      created: new Date(timestamp),
      modified: new Date(timestamp),
      messageCount: 1,
      firstMessage: "Retained conversation",
      searchText: "Retained conversation",
    });
  }
  const catalog: SessionCatalogLike = {
    refresh: async () => records,
    get: async (id) => records.find((record) => record.id === id),
    list: async () => ({
      sessions: [],
      total: 0,
      offset: 0,
      limit: 40,
    }),
    listByIds: async () => [],
    listByCwds: async () => [],
    invalidate() {},
  };
  const workers: PiRpcProcess[] = [];
  const events: Record<string, unknown>[] = [];
  const runtime = new RuntimeController(
    catalog,
    new AttachmentStore(join(root, "uploads")),
    (options) => {
      const rpc = new PiRpcProcess({
        ...options,
        cliPath: piInstallation.cliPath,
        env: {
          ...Object.fromEntries(
            Object.keys(process.env).map((key) => [key, undefined]),
          ),
          ...environment,
          PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
          ...options.env,
        },
        args: [
          ...(options.args ?? []),
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--no-themes",
          "--no-tools",
          "--extension",
          extension,
        ],
      });
      workers.push(rpc);
      rpc.on("event", (event) => events.push(event));
      return rpc;
    },
  );
  const a = records[0]!;
  const b = records[1]!;
  const names = async (id: string) =>
    (
      (await runtime.snapshot(id)).active?.commands as Array<{ name: string }>
    ).map((command) => command.name);
  try {
    for (const record of records) {
      await runtime.openSession(record.id);
      await vi.waitFor(
        async () => expect(await names(record.id)).toContain("reload-fixture"),
        { timeout: 15_000 },
      );
    }
    const pids = workers.map((worker) => worker.pid);
    const before = await readFile(a.path, "utf8");
    expect(await names(a.id)).toContain("removed");
    await rm(join(prompts, "removed.md"));
    await writeFile(join(prompts, "discovered.md"), "DISCOVERED_TEMPLATE");
    await runtime.prompt({ sessionId: a.id, message: "/reload-fixture" });
    expect(await names(a.id)).toContain("discovered");
    expect(await names(a.id)).not.toContain("removed");
    expect(await names(b.id)).toContain("removed");
    expect(await names(b.id)).not.toContain("discovered");

    // Admission must refresh independently of the browser's last snapshot.
    await writeFile(join(prompts, "admitted.md"), "ADMITTED_TEMPLATE");
    await runtime.prompt({ sessionId: a.id, message: "/reload-fixture" });
    await expect(
      runtime.prompt({ sessionId: a.id, message: "/admitted" }),
    ).resolves.toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        method: "notify",
        message: "handled:/admitted",
      }),
    );
    await expect(
      runtime.prompt({ sessionId: a.id, message: "/removed" }),
    ).rejects.toThrow("Unknown Pi command /removed");
    await expect(
      runtime.prompt({ sessionId: a.id, message: "/missing" }),
    ).rejects.toThrow("Unknown Pi command /missing");
    expect(workers).toHaveLength(2);
    expect(workers.map((worker) => worker.pid)).toEqual(pids);
    expect(await readFile(a.path, "utf8")).toBe(before);
  } finally {
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
