import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import { SessionCatalog } from "../../server/session-catalog.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";
import {
  messageEntry,
  thinkingOff,
  writeSession,
} from "./fixtures/session-jsonl.js";

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
  const records = await Promise.all(
    [randomUUID(), randomUUID()].map((id) =>
      writeSession(join(sessions, `${id}.jsonl`), cwd, id, [
        thinkingOff,
        messageEntry("00000001", thinkingOff.id, {
          role: "user",
          content: "Retained conversation",
          timestamp: Date.now(),
        }),
      ]),
    ),
  );
  const workers: PiRpcProcess[] = [];
  const events: Record<string, unknown>[] = [];
  const runtime = new RuntimeController(
    new SessionCatalog(cwd),
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
    const before = await readFile(a.path, "utf8");
    await runtime.openSession(a.id);
    expect(workers).toHaveLength(0);
    for (const name of nativeCommandNames) {
      await runtime.prompt({
        sessionId: a.id,
        message: `/${name}\tkeep paths\nnext`,
      });
      expect(await names(a.id)).toContain(name);
      expect(events).toContainEqual(
        expect.objectContaining({
          method: "notify",
          message: `${name}:keep paths\nnext`,
        }),
      );
    }
    await runtime.openSession(b.id);
    await runtime.setSteeringMode(b.id, "one-at-a-time");
    expect(await names(b.id)).toContain("reload-fixture");
    const pids = workers.map((worker) => worker.pid);
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
