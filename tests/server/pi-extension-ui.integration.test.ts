import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assert, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { piInstallation } from "../../server/pi-runtime.js";
import { RuntimeController } from "../../server/runtime.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";

it("runs the portable UI example through native Pi and preserves Host request/display ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspire-native-ui-"));
  const config = join(root, "config");
  const sessions = join(root, "sessions");
  const sessionId = "77777777-7777-4777-8777-777777777777";
  await mkdir(config);
  vi.stubEnv("PI_CODING_AGENT_DIR", config);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", sessions);
  vi.stubEnv("PI_OFFLINE", "1");
  const path = join(root, "source.jsonl");
  await writeFile(
    path,
    [
      {
        type: "session",
        version: 3,
        id: sessionId,
        cwd: root,
        timestamp: new Date().toISOString(),
      },
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: "Native UI example",
          timestamp: Date.now(),
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const record: SessionRecord = {
    id: sessionId,
    path,
    cwd: root,
    source: null,
    created: new Date(),
    modified: new Date(),
    messageCount: 1,
    firstMessage: "Native UI example",
    searchText: "Native UI example",
  };
  const catalog: SessionCatalogLike = {
    refresh: async () => [record],
    get: async (id) => (id === sessionId ? record : undefined),
    list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
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
        "--session-dir",
        sessions,
        ...(options.args ?? []),
        "--extension",
        resolve("docs/examples/native-ui.ts"),
      ],
      env: {
        ...options.env,
        HOME: root,
        USERPROFILE: root,
        PI_CODING_AGENT_DIR: config,
        PI_CODING_AGENT_SESSION_DIR: sessions,
        PI_OFFLINE: "1",
      },
    });
    workers.push(worker);
    return worker;
  });
  const events: Array<Record<string, unknown>> = [];
  runtime.on("event", (event: Record<string, unknown>) => events.push(event));
  const snapshot = () => runtime.snapshot();
  const question = async (method: string) => {
    await vi.waitFor(
      async () =>
        expect((await snapshot()).pendingExtensionUiRequests?.[0]?.method).toBe(
          method,
        ),
      { timeout: 10_000 },
    );
    const request = (await snapshot()).pendingExtensionUiRequests?.[0];
    assert(
      request && !request.unsupported,
      "Expected a standard extension dialog",
    );
    return request;
  };
  try {
    await runtime.openSession(sessionId);
    expect(piInstallation.version).toBeTruthy();
    // Opening publishes a preview first; the native command inventory fences startup.
    await vi.waitFor(
      async () =>
        expect((await snapshot()).active?.commands).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "ui-demo" }),
          ]),
        ),
      { timeout: 10_000 },
    );
    const worker = workers[0]!;
    const run = runtime.prompt({ sessionId, message: "/ui-demo" });
    const select = await question("select");
    expect(select.options).toEqual(["Documentation", "Code", "Tests"]);
    expect(select.expiresAt).toBeUndefined();
    const pid = worker.pid;
    await runtime.extensionUiResponse({
      sessionId,
      id: select.id,
      value: "Code",
    });
    const confirm = await question("confirm");
    await expect(
      runtime.extensionUiResponse({ sessionId, id: select.id, value: "Tests" }),
    ).rejects.toThrow(/no longer pending/);
    await runtime.extensionUiResponse({
      sessionId,
      id: confirm.id,
      confirmed: true,
    });
    const input = await question("input");
    await runtime.extensionUiResponse({
      sessionId,
      id: input.id,
      value: "Shared interaction",
    });
    const editor = await question("editor");
    expect(editor.prefill).toContain("\n");
    await runtime.extensionUiResponse({
      sessionId,
      id: editor.id,
      value: "Check keyboard.\nCheck touch.",
    });
    await run;
    const completed = await snapshot();
    expect(completed.pendingExtensionUiRequests).toEqual([]);
    expect(completed.extensionStatuses).toEqual({
      "example.ui": "Code review ready: Shared interaction",
    });
    expect(completed.extensionDisplays).toMatchObject([
      {
        kind: "widget",
        placement: "aboveEditor",
        lines: [
          "Code: Shared interaction",
          "Run /ui-demo clear to remove the demo displays.",
        ],
      },
      {
        kind: "widget",
        placement: "belowEditor",
        lines: ["Check keyboard.", "Check touch."],
      },
    ]);
    // A new observer reads the same retained display state, not a replayed command.
    expect((await snapshot()).extensionDisplays).toEqual(
      completed.extensionDisplays,
    );
    expect(
      (await worker.request<{ isStreaming: boolean }>({ type: "get_state" }))
        .isStreaming,
    ).toBe(false);
    expect(events.some((event) => event.type === "agent_start")).toBe(false);
    expect(completed.active!.transcriptPage.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "custom",
          customType: "review_prepared",
          content:
            "**Code review:** Shared interaction\n\nCheck keyboard.\nCheck touch.",
        }),
      ]),
    );
    await runtime.prompt({ sessionId, message: "/ui-demo clear" });
    expect((await snapshot()).extensionStatuses).toEqual({});
    expect((await snapshot()).extensionDisplays).toEqual([]);

    const timedRun = runtime.prompt({
      sessionId,
      message: "/ui-demo timeout 1200",
    });
    const timed = await question("input");
    expect(timed.timeout).toBe(1200);
    expect(timed.expiresAt).toBeGreaterThan(Date.now());
    expect((await snapshot()).pendingExtensionUiRequests?.[0]?.expiresAt).toBe(
      timed.expiresAt,
    );
    await timedRun;
    await vi.waitFor(async () =>
      expect((await snapshot()).pendingExtensionUiRequests).toEqual([]),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "extension_ui_remove",
        id: timed.id,
        reason: "expired",
      }),
    );
    await expect(
      runtime.extensionUiResponse({ sessionId, id: timed.id, value: "late" }),
    ).rejects.toThrow(/no longer pending/);
    expect(worker.pid).toBe(pid);

    const cancelRun = runtime.prompt({ sessionId, message: "/ui-demo" });
    const cancelled = await question("select");
    await runtime.extensionUiResponse({
      sessionId,
      id: cancelled.id,
      cancelled: true,
    });
    await cancelRun;
    expect((await snapshot()).pendingExtensionUiRequests).toEqual([]);
    expect((await snapshot()).extensionStatuses).toEqual({});
  } finally {
    await runtime.close();
    expect(workers.every((worker) => !worker.available)).toBe(true);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
