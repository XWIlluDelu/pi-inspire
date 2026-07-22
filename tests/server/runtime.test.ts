import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import type { PiRpcOptions, PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import type { ActiveSessionSnapshot } from "../../server/session-preview.js";
import type { SessionCatalogLike, SessionRecord } from "../../server/session-catalog.js";

class FakeRpc extends EventEmitter {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly uiResponses: Array<Record<string, unknown>> = [];
  starts = 0;
  stops = 0;
  startGate: Promise<void> | null = null;
  sessionPath: string | null;
  sessionId: string;

  constructor(readonly options: PiRpcOptions) {
    super();
    const marker = options.args?.indexOf("--session") ?? -1;
    this.sessionPath = marker >= 0 ? resolve(options.args![marker + 1]!) : null;
    this.sessionId = this.sessionPath?.split("/").pop()?.replace(/\.jsonl$/, "") ?? "new-id";
  }

  async start(): Promise<void> {
    this.starts += 1;
    if (this.startGate) await this.startGate;
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  async request<T>(command: Record<string, unknown>): Promise<T> {
    this.commands.push(command);
    let value: unknown;
    switch (command.type) {
      case "get_state":
        value = {
          sessionId: this.sessionId,
          sessionFile: this.sessionPath ?? undefined,
          isStreaming: false,
          isCompacting: false,
          thinkingLevel: "medium",
          model: { provider: "test", id: "model" },
        };
        break;
      case "get_messages":
        value = { messages: [] };
        break;
      case "get_session_stats":
        value = {};
        break;
      case "get_available_models":
        value = { models: [] };
        break;
      case "get_commands":
        value = { commands: [] };
        break;
      default:
        value = {};
    }
    return value as T;
  }

  sendExtensionUiResponse(response: Record<string, unknown>): void {
    this.uiResponses.push(response);
  }
}

function record(id: string, cwd: string): SessionRecord {
  return {
    id,
    cwd,
    path: `/sessions/${id}.jsonl`,
    created: new Date("2026-07-22T00:00:00Z"),
    modified: new Date("2026-07-22T00:00:00Z"),
    messageCount: 1,
    firstMessage: id,
    searchText: id,
  };
}

async function preview(session: SessionRecord): Promise<ActiveSessionSnapshot> {
  return {
    sessionId: session.id,
    sessionFile: session.path,
    sessionName: session.name,
    cwd: session.cwd,
    model: { provider: "test", id: "model" },
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    messages: [{ role: "user", content: `preview:${session.id}`, timestamp: 1 }],
    availableModels: [],
    commands: [],
  };
}

function catalog(records: SessionRecord[]): SessionCatalogLike {
  const byId = new Map(records.map((item) => [item.id, item]));
  return {
    refresh: async () => records,
    get: async (id) => byId.get(id),
    list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
    listByIds: async () => [],
    invalidate: () => undefined,
  };
}

const attachments: AttachmentStore[] = [];

afterEach(async () => {
  await Promise.all(attachments.splice(0).map((store) => store.close()));
});

describe("RuntimeController concurrent sessions", () => {
  it("returns the Pi-file preview before extensions finish and makes prompt await readiness", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.startGate = gate;
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );

    const opened = await Promise.race([
      runtime.openSession("a"),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("open waited for worker")), 100)),
    ]);
    expect(opened.active?.messages).toEqual([{ role: "user", content: "preview:a", timestamp: 1 }]);
    expect(worker.starts).toBe(1);

    const prompting = runtime.prompt({ message: "continue" });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(worker.commands.some((command) => command.type === "prompt")).toBe(false);
    release();
    await prompting;
    expect(worker.commands.some((command) => command.type === "prompt")).toBe(true);
    await runtime.close();
  });

  it("single-flights concurrent opens of the same session", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolveGate) => {
      releasePreview = resolveGate;
    });
    let previewCalls = 0;
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      async (session) => {
        previewCalls += 1;
        await previewGate;
        return preview(session);
      },
    );

    const first = runtime.openSession("a");
    const second = runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(previewCalls).toBe(1);
    releasePreview();
    await Promise.all([first, second]);
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(workers).toHaveLength(1);
    expect(workers[0]!.starts).toBe(1);

    await runtime.close();
    expect(workers[0]!.stops).toBe(1);
  });

  it("keeps one independent worker per opened session and never stops one during view changes", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/project/one"), record("b", "/project/one"), record("c", "/project/two")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );

    await runtime.openSession("a");
    await runtime.openSession("b");
    await runtime.openSession("c");
    expect(workers).toHaveLength(3);
    expect(workers.map((worker) => worker.options.cwd)).toEqual(["/project/one", "/project/one", "/project/two"]);
    expect(workers.every((worker) => worker.stops === 0)).toBe(true);

    await runtime.openSession("a");
    expect(workers).toHaveLength(3);
    expect(workers.every((worker) => worker.stops === 0)).toBe(true);

    await runtime.close();
    expect(workers.every((worker) => worker.stops === 1)).toBe(true);
  });

  it("publishes running and unseen completion state, then acknowledges it when viewed", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const workers: FakeRpc[] = [];
    const events: Array<Record<string, unknown>> = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/project"), record("b", "/project")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    runtime.on("event", (event) => events.push(event as Record<string, unknown>));

    await runtime.openSession("a");
    await runtime.openSession("b");
    workers[0]!.emit("event", { type: "agent_start" });
    expect((await runtime.snapshot()).sessionStatuses.a).toEqual({ runState: "running", indicator: "running" });

    workers[0]!.emit("event", { type: "agent_settled" });
    expect((await runtime.snapshot()).sessionStatuses.a).toEqual({ runState: "idle", indicator: "completed" });
    expect(events.at(-1)).toMatchObject({ type: "agent_settled", sessionId: "a", sessionStatus: { indicator: "completed" } });

    await runtime.openSession("a");
    expect((await runtime.snapshot()).sessionStatuses.a).toEqual({ runState: "idle" });

    workers[1]!.emit("event", { type: "agent_start" });
    workers[1]!.emit("event", { type: "message_end", message: { role: "assistant", stopReason: "error" } });
    workers[1]!.emit("event", { type: "agent_settled" });
    expect((await runtime.snapshot()).sessionStatuses.b).toEqual({ runState: "failed", indicator: "failed" });

    await runtime.openSession("b");
    expect((await runtime.snapshot()).sessionStatuses.b).toEqual({ runState: "failed" });
    await runtime.close();
  });

  it("keeps a read-only recovery snapshot and clears stale dialogs after worker exit", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );

    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    worker.emit("event", { type: "extension_ui_request", id: "question-1", method: "confirm" });
    worker.emit("exit", new Error("worker crashed"));

    const recovered = await runtime.snapshot();
    expect(recovered.active?.messages).toEqual([{ role: "user", content: "preview:a", timestamp: 1 }]);
    expect(recovered.runState).toBe("failed");
    expect(recovered.pendingExtensionUi).toBeNull();
    expect(recovered.sessionStatuses.a).toEqual({ runState: "failed" });
    await runtime.close();
  });

  it("restores a background extension dialog when its session is viewed", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/project"), record("b", "/project")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );

    await runtime.openSession("a");
    await runtime.openSession("b");
    workers[0]!.emit("event", {
      type: "extension_ui_request",
      id: "question-1",
      method: "confirm",
      title: "Proceed?",
      message: "Confirm the operation",
    });
    expect((await runtime.snapshot()).pendingExtensionUi).toBeNull();

    const restored = await runtime.openSession("a");
    expect(restored.pendingExtensionUi).toEqual({
      sessionId: "a",
      id: "question-1",
      method: "confirm",
      title: "Proceed?",
      message: "Confirm the operation",
    });
    await runtime.openSession("b");
    await runtime.extensionUiResponse({ sessionId: "a", id: "question-1", value: true });
    expect(workers[0]!.uiResponses).toEqual([{ id: "question-1", value: true }]);
    expect(workers[1]!.uiResponses).toEqual([]);
    expect((await runtime.openSession("a")).pendingExtensionUi).toBeNull();
    await runtime.close();
  });
});
