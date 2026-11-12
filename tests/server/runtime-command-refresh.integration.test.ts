import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import type { SessionRecord } from "../../server/session-catalog.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";
import { catalog } from "./fixtures/runtime.js";

const nativeCommandNames = ["audit.inspect", "审阅/检查"];

it("refreshes commands and extension UI on native reload without replacing either worker", async () => {
  const { root, agent, cwd, sessions, env } = await nativePiWorkspace(
    "inspire-command-refresh-",
    {
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      defaultProjectTrust: "never",
      compaction: { enabled: false },
      retry: { enabled: false },
      packages: [],
    },
  );
  stubNativePiEnvironment(env);
  const prompts = join(agent, "prompts");
  await mkdir(prompts);
  const extension = join(root, "reload.ts");
  await writeFile(
    extension,
    `export default function (pi) {
    pi.on("session_shutdown", (event, ctx) => {
      if (event.reason === "reload") ctx.ui.setStatus("fixture.cleanup", "old shutdown");
    });
    pi.on("session_start", (event, ctx) => {
      const phase = event.reason === "reload" ? "fresh" : "old";
      ctx.ui.setStatus("fixture." + phase, phase);
      ctx.ui.setWidget("fixture." + phase, [phase], {placement: "belowEditor"});
    });
    for (const name of ${JSON.stringify(nativeCommandNames)}) {
      pi.registerCommand(name, {
        handler: async (argument, ctx) => { ctx.ui.notify(name + ":" + argument, "info"); }
      });
    }
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
    });
  }
  const workers: PiRpcProcess[] = [];
  const events: Record<string, unknown>[] = [];
  const runtime = new RuntimeController(
    catalog(records),
    new AttachmentStore(join(root, "uploads")),
    {
      createProcess: (options) => {
        const rpc = new PiRpcProcess({
          ...options,
          env: { ...env, ...options.env },
          args: [
            ...(options.args ?? []),
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
    },
  );
  const browserEvents: Record<string, unknown>[] = [];
  runtime.on("event", (event: Record<string, unknown>) =>
    browserEvents.push(event),
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
    for (const name of nativeCommandNames) {
      expect(await names(a.id)).toContain(name);
      await runtime.prompt({
        sessionId: a.id,
        message: `/${name}\tkeep paths\nnext`,
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          method: "notify",
          message: `${name}:keep paths\nnext`,
        }),
      );
    }
    await runtime.prompt({ sessionId: a.id, message: "/tmp/project/file" });
    expect(events).toContainEqual(
      expect.objectContaining({
        method: "notify",
        message: "handled:/tmp/project/file",
      }),
    );
    expect(await names(a.id)).toContain("removed");
    await rm(join(prompts, "removed.md"));
    await writeFile(join(prompts, "discovered.md"), "DISCOVERED_TEMPLATE");
    await runtime.prompt({ sessionId: a.id, message: "/reload-fixture" });
    const fresh = await runtime.snapshot(a.id);
    const untouched = await runtime.snapshot(b.id);
    expect(fresh.extensionStatuses).toEqual({
      "fixture.fresh": "fresh",
    });
    expect(fresh.extensionDisplays).toMatchObject([
      { label: "fixture.fresh", lines: ["fresh"] },
    ]);
    expect(untouched.extensionStatuses).toEqual({
      "fixture.old": "old",
    });
    expect(untouched.extensionDisplays).toMatchObject([
      { label: "fixture.old", lines: ["old"] },
    ]);
    expect(browserEvents).toContainEqual(
      expect.objectContaining({
        type: "extension_ui_request",
        extensionStatuses: {},
        extensionDisplays: [],
      }),
    );
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
    expect(workers).toHaveLength(2);
    expect(workers.map((worker) => worker.pid)).toEqual(pids);
    expect(await readFile(a.path, "utf8")).toBe(before);
  } finally {
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
