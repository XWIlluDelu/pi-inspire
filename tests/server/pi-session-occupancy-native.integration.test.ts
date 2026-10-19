import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import {
  piActivityDirectory,
  type PiActivityRecord,
} from "../../docs/examples/session-activity.js";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { PiSessionOccupancy } from "../../server/pi-session-occupancy.js";
import { RuntimeController } from "../../server/runtime.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";

it("fences a real independent RPC owner through idle, work and reload, then releases on native session replacement", async () => {
  const workspace = await nativePiWorkspace("inspire-native-occupancy-", {
    defaultProjectTrust: "never",
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  stubNativePiEnvironment(workspace.env);
  const sessionId = randomUUID(),
    otherId = randomUUID();
  const sessionFile = join(workspace.sessions, sessionId + ".jsonl");
  const otherFile = join(workspace.sessions, otherId + ".jsonl");
  const shutdownEntered = join(workspace.root, "shutdown-entered");
  const shutdownProceed = join(workspace.root, "shutdown-proceed");
  const timestamp = new Date().toISOString();
  for (const [id, file] of [
    [sessionId, sessionFile],
    [otherId, otherFile],
  ]) {
    await writeFile(
      file!,
      JSON.stringify({
        type: "session",
        version: 3,
        id,
        cwd: workspace.cwd,
        timestamp,
      }) + "\n",
    );
  }
  const session: SessionRecord = {
    id: sessionId,
    path: sessionFile,
    cwd: workspace.cwd,
    created: new Date(timestamp),
    modified: new Date(timestamp),
    source: null,
    messageCount: 0,
    firstMessage: "",
    searchText: "",
  };
  const catalog: SessionCatalogLike = {
    refresh: async () => [session],
    get: async (id) => (id === sessionId ? session : undefined),
    list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
    listByIds: async () => [],
    listByCwds: async () => [],
    invalidate() {},
  };
  const records = async () => {
    const directory = piActivityDirectory();
    const result = await Promise.all(
      (await readdir(directory).catch(() => []))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => ({
          name,
          record: JSON.parse(
            await readFile(join(directory, name), "utf8"),
          ) as PiActivityRecord,
        })),
    );
    return result.filter(({ record }) => !record.inactive && !record.released);
  };
  const external = new PiRpcProcess({
    cwd: workspace.cwd,
    env: {
      ...workspace.env,
      INSPIRE_MODEL_FIXTURE_STREAM_DELAY_MS: "700",
      INSPIRE_FIXTURE_SHUTDOWN_ENTERED: shutdownEntered,
      INSPIRE_FIXTURE_SHUTDOWN_PROCEED: shutdownProceed,
    },
    args: [
      "--session",
      sessionFile,
      "--provider",
      "global-native",
      "--model",
      "a",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--no-tools",
      "--no-approve",
      "--extension",
      resolve("docs/examples/session-activity.ts"),
      "--extension",
      resolve("tests/fixtures/pi-model-workflow-extension.ts"),
      "--extension",
      resolve("tests/fixtures/pi-resource-reload-extension.ts"),
      "--extension",
      resolve("tests/fixtures/pi-session-shutdown-extension.ts"),
    ],
  });
  const create = vi.fn(() => {
    throw new Error("Must not start a second Pi");
  });
  const guard = new PiSessionOccupancy();
  const attachments = new AttachmentStore(
    join(workspace.root, "uploads"),
    null,
    { sessionDirectories: [workspace.sessions], sweepIntervalMs: 0 },
  );
  const runtime = new RuntimeController(catalog, attachments, create)
    .setExternalSessionConnector(async () => null)
    .setExternalSessionGuard((id, file) => guard.assertWritable(id, file));
  try {
    await external.start();
    const pid = external.pid;
    await vi.waitFor(async () =>
      expect(await records()).toMatchObject([
        {
          record: {
            pid,
            sessionId,
            processIdentity: expect.any(String),
            activity: "idle",
          },
        },
      ]),
    );
    const firstFile = (await records())[0]!.name;
    await runtime.openSession(sessionId);
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).active?.readOnlyReason).toBe(
        "external-active",
      ),
    );
    expect(create).not.toHaveBeenCalled();

    await external.request({
      type: "prompt",
      message: "An independent fixture turn.",
    });
    await vi.waitFor(async () =>
      expect((await records())[0]?.record.activity).toBe("working"),
    );
    await expect(
      runtime.prompt({
        sessionId,
        message: "Never deliver to a replacement writer",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(async () =>
      expect((await records())[0]?.record.activity).toBe("idle"),
    );
    await runtime.openSession(sessionId);
    expect(create).not.toHaveBeenCalled();

    await external.request({ type: "prompt", message: "/fixture-reload" });
    expect(await records()).toMatchObject([
      { name: firstFile, record: { sessionId, pid } },
    ]);
    expect(await records()).toHaveLength(1);
    await expect(
      guard.assertWritable(sessionId, sessionFile),
    ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });

    const switching = external.request({
      type: "switch_session",
      sessionPath: otherFile,
    });
    try {
      await vi.waitFor(async () =>
        expect(await readFile(shutdownEntered, "utf8")).toBe(sessionId),
      );
      // The later hook will still append to the outgoing JSONL. Neither its
      // inactive marker nor a stopped heartbeat grants a new local writer.
      await expect(
        guard.assertWritable(sessionId, sessionFile),
      ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });
      await runtime.openSession(sessionId);
      expect((await runtime.snapshot()).active?.readOnlyReason).toBe(
        "external-active",
      );
      expect(create).not.toHaveBeenCalled();
    } finally {
      await writeFile(shutdownProceed, "continue");
      await switching;
    }
    const outgoing = (await readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      outgoing.some(
        (entry) => entry.customType === "fixture-shutdown-completed",
      ),
    ).toBe(true);
    expect(await records()).toMatchObject([
      { name: firstFile, record: { pid, sessionId: otherId } },
    ]);
    expect(external.pid).toBe(pid);
    await expect(
      guard.assertWritable(sessionId, sessionFile),
    ).resolves.toBeUndefined();
    await expect(
      guard.assertWritable(otherId, otherFile),
    ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });
    expect(create).not.toHaveBeenCalled();
    await external.stop();
    await expect(
      guard.assertWritable(otherId, otherFile),
    ).resolves.toBeUndefined();
  } finally {
    await runtime.close();
    await attachments.close();
    await external.stop();
    vi.unstubAllEnvs();
    await rm(workspace.root, { recursive: true, force: true });
  }
}, 60_000);
