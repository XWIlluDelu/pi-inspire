import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { piInstallation } from "../../server/pi-runtime.js";
import { RuntimeController } from "../../server/runtime.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";

const directories: string[] = [];
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(trust: "always" | "never", enabled?: boolean) {
  const root = await mkdtemp(join(tmpdir(), "inspire-native-retry-"));
  directories.push(root);
  const agent = join(root, "agent");
  const sessions = join(root, "sessions");
  for (const [key, value] of Object.entries({
    HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  }))
    vi.stubEnv(key, value);
  await mkdir(agent, { recursive: true });
  await mkdir(sessions, { recursive: true });
  const globalPath = join(agent, "settings.json");
  await writeFile(
    globalPath,
    JSON.stringify({
      defaultProjectTrust: trust,
      enableInstallTelemetry: false,
      cacheWarming: "off",
      ...(enabled === undefined ? {} : { retry: { enabled } }),
      compaction: { enabled: true },
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    }),
  );
  await writeFile(join(agent, "auth.json"), "{}");
  const records: SessionRecord[] = [];
  for (const [index, id] of IDS.entries()) {
    const cwd = join(root, `project-${index}`);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    if (index === 0)
      await writeFile(
        join(cwd, ".pi/settings.json"),
        JSON.stringify({
          retry: { enabled: false },
          compaction: { enabled: false },
        }),
      );
    const path = join(sessions, `${id}.jsonl`);
    const timestamp = "2026-01-01T00:00:00.000Z";
    await writeFile(
      path,
      [
        { type: "session", version: 3, id, cwd, timestamp },
        {
          type: "thinking_level_change",
          id: "t1",
          parentId: null,
          timestamp,
          thinkingLevel: "off",
        },
        {
          type: "message",
          id: "u1",
          parentId: "t1",
          timestamp,
          message: { role: "user", content: "offline fixture", timestamp: 1 },
        },
        {
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "offline answer" }],
            timestamp: 2,
            api: "openai-completions",
            provider: "fixture",
            model: "fixture",
            stopReason: "stop",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    records.push({
      id,
      cwd,
      path,
      source: null,
      created: new Date(timestamp),
      modified: new Date(timestamp),
      messageCount: 2,
      firstMessage: "offline fixture",
      searchText: "offline fixture",
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
  const attachments = new AttachmentStore(join(root, "uploads"));
  const workers: PiRpcProcess[] = [];
  const runtime = new RuntimeController(catalog, attachments, (options) => {
    const worker = new PiRpcProcess({
      ...options,
      args: [
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-tools",
        ...(options.args ?? []),
      ],
    });
    workers.push(worker);
    return worker;
  });
  const events: Record<string, unknown>[] = [];
  runtime.on("event", (event) => events.push(event));
  return {
    runtime,
    records,
    workers,
    events,
    globalPath,
    close: async () => {
      await runtime.close();
      await attachments.close();
      expect(
        workers.every((worker) => !worker.available && worker.pid === null),
      ).toBe(true);
    },
  };
}

describe("native effective retry settings", () => {
  it.each(["always", "never"] as const)(
    "respects %s project trust before and after the native setters",
    async (trust) => {
      expect(
        Number(piInstallation.version.split(".")[0]),
      ).toBeGreaterThanOrEqual(1);
      const { runtime, records, workers, events, globalPath, close } =
        await fixture(trust, true);
      const record = records[0]!;
      const original = await readFile(record.path, "utf8");
      try {
        await runtime.openSession(record.id);
        await runtime.setSteeringMode(record.id, "all");
        const effective = trust === "never";
        expect(
          (await runtime.snapshot(record.id)).active?.runtimeSettings,
        ).toEqual({
          autoRetryEnabled: effective,
          autoCompactionEnabled: effective,
          steeringMode: "all",
          followUpMode: "one-at-a-time",
        });
        await runtime.setAutoRetry(record.id, true);
        await runtime.setAutoCompaction(record.id, true);
        await runtime.setFollowUpMode(record.id, "all");
        const snapshot = await runtime.snapshot(record.id);
        expect(snapshot.active?.runtimeSettings).toEqual({
          autoRetryEnabled: effective,
          autoCompactionEnabled: effective,
          steeringMode: "all",
          followUpMode: "all",
        });
        expect(snapshot.active?.commands).toEqual([]);
        expect(snapshot.extensionStatuses).toEqual({});
        expect(
          events.some(
            (event) =>
              event.method === "setStatus" ||
              event.method === "notify" ||
              event.type === "message_start",
          ),
        ).toBe(false);
        expect(
          await workers[0]!.request({ type: "get_messages" }),
        ).toMatchObject({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "user",
              content: "offline fixture",
            }),
          ]),
        });
        expect(await readFile(record.path, "utf8")).toBe(original);
        await vi.waitFor(async () =>
          expect(JSON.parse(await readFile(globalPath, "utf8"))).toMatchObject({
            retry: { enabled: true },
          }),
        );
      } finally {
        await close();
      }
    },
    20_000,
  );

  it("reads the native default and keeps live workers and replacements independent", async () => {
    const { runtime, records, workers, globalPath, close } =
      await fixture("always");
    const overridden = records[0]!;
    const ordinary = records[1]!;
    try {
      await runtime.openSession(ordinary.id);
      await runtime.setSteeringMode(ordinary.id, "all");
      expect(
        (await runtime.snapshot(ordinary.id)).active?.runtimeSettings
          ?.autoRetryEnabled,
      ).toBe(true);
      await runtime.setAutoRetry(ordinary.id, false);
      expect(
        (await runtime.snapshot(ordinary.id)).active?.runtimeSettings
          ?.autoRetryEnabled,
      ).toBe(false);
      await runtime.setAutoRetry(ordinary.id, true);
      expect(
        (await runtime.snapshot(ordinary.id)).active?.runtimeSettings
          ?.autoRetryEnabled,
      ).toBe(true);
      await runtime.openSession(overridden.id);
      await runtime.setAutoRetry(overridden.id, false);
      expect(
        (await runtime.snapshot()).active?.runtimeSettings?.autoRetryEnabled,
      ).toBe(false);
      expect(
        (await runtime.snapshot(ordinary.id)).active?.runtimeSettings
          ?.autoRetryEnabled,
      ).toBe(true);
      await vi.waitFor(async () =>
        expect(JSON.parse(await readFile(globalPath, "utf8"))).toMatchObject({
          retry: { enabled: false },
        }),
      );
      const previousWorker = workers[0]!;
      const result = await runtime.nativeCommand({
        sessionId: ordinary.id,
        command: "reload",
      });
      expect(result.outcome).toBe("completed");
      expect(previousWorker.available).toBe(false);
      expect(workers).toHaveLength(3);
      expect(
        (await runtime.snapshot(ordinary.id)).active?.runtimeSettings
          ?.autoRetryEnabled,
      ).toBe(false);
      await runtime.setAutoRetry(ordinary.id, true);
      expect(
        (await runtime.openSession(overridden.id)).active?.runtimeSettings
          ?.autoRetryEnabled,
      ).toBe(false);
      expect(
        (await runtime.openSession(ordinary.id)).active?.runtimeSettings
          ?.autoRetryEnabled,
      ).toBe(true);
    } finally {
      await close();
    }
  }, 30_000);
});
