import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import type { PiRpcOptions, PiRpcProcess } from "../../server/pi-rpc.js";
import { MAX_IDLE_WORKERS, RuntimeController, safeProjection } from "../../server/runtime.js";
import type { ActiveSessionSnapshot } from "../../server/session-preview.js";
import type { SessionCatalogLike, SessionRecord } from "../../server/session-catalog.js";

class FakeRpc extends EventEmitter {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly uiResponses: Array<Record<string, unknown>> = [];
  starts = 0;
  stops = 0;
  failPrompts = false;
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
    if (command.type === "prompt" && this.failPrompts) throw new Error("prompt rejected");
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

function upload(name: string, type: string): Express.Multer.File {
  const buffer = Buffer.from("payload");
  return { originalname: name, mimetype: type, size: buffer.length, buffer } as Express.Multer.File;
}

afterEach(async () => {
  await Promise.all(attachments.splice(0).map((store) => store.close()));
});

describe("browser-safe runtime projection", () => {
  it("redacts credential-shaped fields and bounds oversized values", () => {
    const projected = safeProjection({
      authorization: "Bearer secret",
      nested: { apiKey: "secret", message: "x".repeat(250_001) },
      items: Array.from({ length: 10_001 }, (_, index) => index),
    }) as Record<string, unknown>;

    expect(projected.authorization).toBe("[redacted]");
    expect((projected.nested as Record<string, unknown>).apiKey).toBe("[redacted]");
    expect(String((projected.nested as Record<string, unknown>).message).endsWith("…[truncated]")).toBe(true);
    expect(projected.items).toHaveLength(10_000);
  });
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

    const prompting = runtime.prompt({ sessionId: "a", message: "continue" });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(worker.commands.some((command) => command.type === "prompt")).toBe(false);
    release();
    await prompting;
    expect(worker.commands.some((command) => command.type === "prompt")).toBe(true);
    await runtime.close();
  });

  it("shields prompt attachments from a DELETE racing the gated delivery", async () => {
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
    await runtime.openSession("a");

    const doc = await store.add(upload("notes.txt", "text/plain"));
    const prompting = runtime.prompt({ sessionId: "a", message: "use the note", attachmentIds: [doc.id] });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    // The prompt owns the file while delivery waits on the worker; the
    // racing withdrawal must be moot.
    await store.remove(doc.id);
    release();
    await prompting;

    const promptCommand = worker.commands.find((command) => command.type === "prompt");
    const referenced = String(promptCommand?.message ?? "").split("\n- ")[1];
    expect(referenced).toContain("notes.txt");
    await expect(access(referenced!)).resolves.toBeUndefined();
    // Consumed after delivery: a late DELETE is equally moot.
    await store.remove(doc.id);
    await expect(access(referenced!)).resolves.toBeUndefined();
    await runtime.close();
  });

  it("rejects a prompt reusing an in-flight attachment without breaking the first lease", async () => {
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
    await runtime.openSession("a");

    const doc = await store.add(upload("notes.txt", "text/plain"));
    const prompting = runtime.prompt({ sessionId: "a", message: "first", attachmentIds: [doc.id] });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    await expect(runtime.prompt({ sessionId: "a", message: "second", attachmentIds: [doc.id] })).rejects.toThrow(
      /already belong/,
    );
    // Neither the rejected prompt's failure path nor a racing DELETE may
    // break the lease the first prompt still holds.
    await store.remove(doc.id);
    release();
    await prompting;

    const promptCommand = worker.commands.find((command) => command.type === "prompt");
    const referenced = String(promptCommand?.message ?? "").split("\n- ")[1];
    await expect(access(referenced!)).resolves.toBeUndefined();
    await runtime.close();
  });

  it("settles the lease handback before a failed prompt's response", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let releaseResolve!: () => void;
    const resolveGate = new Promise<void>((resolveGateNow) => {
      releaseResolve = resolveGateNow;
    });
    // Hold the resolve open past its lease-taking, like a slow image read,
    // while the project-file branch fails fast.
    const innerResolve = store.resolveForPrompt.bind(store);
    store.resolveForPrompt = async (ids?: string[]) => {
      const resolved = await innerResolve(ids);
      await resolveGate;
      return resolved;
    };
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
    );
    await runtime.openSession("a");

    const doc = await store.add(upload("notes.txt", "text/plain"));
    let rejected = false;
    const prompting = runtime.prompt({
      sessionId: "a",
      message: "use it",
      attachmentIds: [doc.id],
      projectFiles: ["/definitely/not/in/project"],
    });
    prompting.catch(() => {
      rejected = true;
    });
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 25));
    // The failure response must wait for the leases to come home: a client
    // reacting to the error instantly may withdraw the attachment.
    expect(rejected).toBe(false);

    releaseResolve();
    await expect(prompting).rejects.toThrow();
    // By the time the client sees the failure, withdrawal works again.
    await store.remove(doc.id);
    await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(/expired/);
    await runtime.close();
  });

  it("restages attachments when Pi rejects the prompt so they stay withdrawable", async () => {
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
    worker.failPrompts = true;

    const doc = await store.add(upload("notes.txt", "text/plain"));
    await expect(runtime.prompt({ sessionId: "a", message: "use the note", attachmentIds: [doc.id] })).rejects.toThrow(
      "prompt rejected",
    );
    // Failed delivery restages the file: the withdrawal now works.
    await store.remove(doc.id);
    await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(/expired/);
    await runtime.close();
  });

  it("delivers addressed writes to their named session, not the current selection", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
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

    // Selection is b; writes addressed to a still land on a's worker.
    await runtime.prompt({ sessionId: "a", message: "background instruction" });
    await runtime.rename("a", "renamed A");
    const workerA = workers.find((worker) => worker.sessionId === "a")!;
    const workerB = workers.find((worker) => worker.sessionId === "b");
    expect(workerA.commands.some((command) => command.type === "prompt" && command.message === "background instruction")).toBe(true);
    expect(workerA.commands.some((command) => command.type === "set_session_name" && command.name === "renamed A")).toBe(true);
    expect(workerB?.commands.some((command) => command.type === "prompt") ?? false).toBe(false);
    expect(runtime.activeSessionId).toBe("b");
    await runtime.close();
  });

  it("keeps the newest selection when an earlier open completes late", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolveGate) => {
      releaseA = resolveGate;
    });
    const runtime = new RuntimeController(
      catalog([record("a", "/project"), record("b", "/project")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      async (session) => {
        if (session.id === "a") await gateA;
        return preview(session);
      },
    );
    const openingA = runtime.openSession("a");
    const openedB = await runtime.openSession("b");
    expect(openedB.active?.sessionId).toBe("b");
    releaseA();
    await openingA;
    // The slower A open answered its caller but did not steal the selection.
    expect(runtime.activeSessionId).toBe("b");
    await runtime.close();
  });

  it("retries an in-flight snapshot when selection changes", async () => {
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
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));

    let releaseSnapshot!: () => void;
    const gate = new Promise<void>((resolveGate) => (releaseSnapshot = resolveGate));
    let snapshotStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => (snapshotStarted = resolveStarted));
    const workerA = workers[0]!;
    const request = workerA.request.bind(workerA);
    workerA.request = async <T,>(command: Record<string, unknown>): Promise<T> => {
      if (command.type === "get_state") {
        snapshotStarted();
        await gate;
      }
      return request<T>(command);
    };

    const snapshotting = runtime.snapshot();
    await started;
    await runtime.openSession("b");
    releaseSnapshot();

    const snapshot = await snapshotting;
    expect(snapshot.active?.sessionId).toBe("b");
    expect(runtime.activeSessionId).toBe("b");
    await runtime.close();
  });

  it("loads resource messages lazily and caches them until the next message event", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/project")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    worker.emit("event", { type: "message_update", message: { role: "assistant", timestamp: 2 } });

    const context = await runtime.resourceContext("a");
    expect(worker.commands.filter((command) => command.type === "get_messages")).toHaveLength(0);
    await context.loadMessages!();
    await context.loadMessages!();
    expect(worker.commands.filter((command) => command.type === "get_messages")).toHaveLength(1);
    await runtime.close();
  });

  it("keeps an accepted prompt non-evictable until its lifecycle event arrives", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const ids = ["a", "b", "c", "d", "e", "f"];
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog(ids.map((id) => record(id, "/tmp"))),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    for (const id of ids.slice(0, 4)) await runtime.openSession(id);
    await runtime.prompt({ sessionId: "a", message: "accepted before agent_start" });
    await runtime.openSession("e");
    await runtime.openSession("f");

    await vi.waitFor(() => expect(workers.find((worker) => worker.sessionId === "b")?.stops).toBe(1));
    expect(workers.find((worker) => worker.sessionId === "a")?.stops).toBe(0);
    expect((await runtime.snapshot()).sessionStatuses.a).toMatchObject({ runState: "queued", indicator: "running" });
    await runtime.close();
  });

  it("keeps an extension-response worker protected until Pi acknowledges the ordered input", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const ids = ["a", "b", "c", "d", "e", "f"];
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog(ids.map((id) => record(id, "/project"))),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    for (const id of ids.slice(0, 4)) await runtime.openSession(id);
    const workerA = workers.find((worker) => worker.sessionId === "a")!;
    workerA.emit("event", { type: "extension_ui_request", id: "question-a", method: "confirm" });

    let releaseAck!: () => void;
    const ackGate = new Promise<void>((resolveGate) => (releaseAck = resolveGate));
    let ackStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => (ackStarted = resolveStarted));
    const request = workerA.request.bind(workerA);
    workerA.request = async <T,>(command: Record<string, unknown>): Promise<T> => {
      if (command.type === "get_state") {
        ackStarted();
        await ackGate;
      }
      return request<T>(command);
    };

    const responding = runtime.extensionUiResponse({ sessionId: "a", id: "question-a", confirmed: true });
    await started;
    await runtime.openSession("e");
    await runtime.openSession("f");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(workerA.stops).toBe(0);

    releaseAck();
    await responding;
    expect(workerA.uiResponses).toEqual([{ id: "question-a", confirmed: true }]);
    await runtime.close();
  });

  it("routes a typed /compact to the RPC compact command instead of prompting", async () => {
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
    await runtime.prompt({ sessionId: "a", message: "/compact focus on the parser work" });
    expect(worker.commands.find((command) => command.type === "compact")).toMatchObject({
      customInstructions: "focus on the parser work",
    });
    expect(worker.commands.some((command) => command.type === "prompt")).toBe(false);

    // Only the exact command is intercepted; similar text still prompts.
    await runtime.prompt({ sessionId: "a", message: "/compaction strategies?" });
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

  it("bounds the idle worker cache without stopping busy or extension-blocked sessions", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const workers: FakeRpc[] = [];
    const previewCalls = new Map<string, number>();
    const runtime = new RuntimeController(
      catalog(ids.map((id) => record(id, "/project"))),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      async (session) => {
        previewCalls.set(session.id, (previewCalls.get(session.id) ?? 0) + 1);
        return preview(session);
      },
    );

    await runtime.openSession("a");
    workers[0]!.emit("event", { type: "agent_start" });
    await runtime.openSession("b");
    workers[1]!.emit("event", { type: "extension_ui_request", id: "question-b", method: "confirm" });
    for (const id of ids.slice(2)) await runtime.openSession(id);

    await vi.waitFor(() => expect(workers.filter((worker) => worker.stops === 0)).toHaveLength(MAX_IDLE_WORKERS + 3));
    expect(workers[0]!.stops).toBe(0); // busy
    expect(workers[1]!.stops).toBe(0); // awaiting extension input
    expect(workers[2]!.stops).toBe(1); // oldest reclaimable idle worker

    workers[0]!.emit("event", { type: "agent_settled" });
    await runtime.extensionUiResponse({ sessionId: "b", id: "question-b", confirmed: true });
    await vi.waitFor(() => expect(workers.filter((worker) => worker.stops === 0)).toHaveLength(MAX_IDLE_WORKERS + 1));

    // Reopening a reclaimed session transparently starts one replacement,
    // after the previous process has stopped.
    await runtime.openSession("c");
    await vi.waitFor(() => expect(workers.filter((worker) => worker.sessionId === "c")).toHaveLength(2));
    expect(workers.filter((worker) => worker.sessionId === "c").map((worker) => worker.stops)).toEqual([1, 0]);
    expect(previewCalls.get("c")).toBe(2);
    await runtime.close();
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

  it("rebinds an extension dialog raised before Pi reports the final session id", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker!: FakeRpc;
    const events: Array<Record<string, unknown>> = [];
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        const start = worker.start.bind(worker);
        worker.start = async () => {
          await start();
          // Arrives while the slot still carries its provisional identity.
          worker.emit("event", { type: "extension_ui_request", id: "trust-1", method: "confirm", title: "Trust?" });
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    runtime.on("event", (event) => events.push(event as Record<string, unknown>));

    const created = await runtime.newSession("/tmp");
    expect(created.active?.sessionId).toBe("new-id");
    expect(created.pendingExtensionUi).toMatchObject({ sessionId: "new-id", id: "trust-1", method: "confirm" });
    // No event may ever leave the host addressed to a pending-* session.
    expect(events.every((event) => !String(event.sessionId ?? "").startsWith("pending-"))).toBe(true);
    await runtime.extensionUiResponse({ sessionId: "new-id", id: "trust-1", value: true });
    expect(worker.uiResponses).toEqual([{ id: "trust-1", value: true }]);
    await runtime.close();
  });

  it("reclaims consumed image uploads after a delivered prompt but keeps file uploads readable", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const image = await store.add(upload("shot.png", "image/png"));
    const file = await store.add(upload("notes.txt", "text/plain"));
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
    await runtime.prompt({ sessionId: "a", message: "use these", attachmentIds: [image.id, file.id] });
    // Image bytes travelled inside the prompt request; the cache entry is gone.
    await expect(store.resolveForPrompt([image.id])).rejects.toThrow(/expired/);
    // The ordinary file's host path is referenced by the conversation text:
    // it stays readable on disk, but cannot join a second message.
    const promptCommand = worker.commands.find((command) => command.type === "prompt");
    const referenced = String(promptCommand?.message ?? "").split("\n- ")[1];
    expect(referenced).toContain("notes.txt");
    await expect(access(referenced!)).resolves.toBeUndefined();
    await expect(store.resolveForPrompt([file.id])).rejects.toThrow(/already belong/);
    await runtime.close();
  });
});
