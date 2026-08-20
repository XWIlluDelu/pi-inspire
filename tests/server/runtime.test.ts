import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import {
  PiRpcOutcomeUnknownError,
  type PiRpcOptions,
  type PiRpcProcess,
} from "../../server/pi-rpc.js";
import {
  MAX_IDLE_WORKERS,
  PI_STARTUP_RESPONSE_UI_ERROR,
  RuntimeController,
  safeProjection,
} from "../../server/runtime.js";
import type { ActiveSessionSnapshot } from "../../server/session-preview.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";

class FakeRpc extends EventEmitter {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly uiResponses: Array<Record<string, unknown>> = [];
  starts = 0;
  stops = 0;
  failPrompts = false;
  startupEvent: Record<string, unknown> | null = null;
  startGate: Promise<void> | null = null;
  sessionPath: string | null;
  sessionId: string;

  constructor(readonly options: PiRpcOptions) {
    super();
    const marker = options.args?.indexOf("--session") ?? -1;
    this.sessionPath = marker >= 0 ? resolve(options.args![marker + 1]!) : null;
    this.sessionId =
      this.sessionPath
        ?.split("/")
        .pop()
        ?.replace(/\.jsonl$/, "") ?? "new-id";
  }

  async start(): Promise<void> {
    this.starts += 1;
    if (this.startupEvent) this.emit("event", this.startupEvent);
    if (this.startGate) await this.startGate;
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  async request<T>(command: Record<string, unknown>): Promise<T> {
    this.commands.push(command);
    if (command.type === "prompt" && this.failPrompts)
      throw new Error("prompt rejected");
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
      case "get_entries":
        value = { entries: [], leafId: command.since ?? null };
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
    transcriptPage: {
      sessionId: session.id,
      revision: 1,
      viewId: `view-${session.id}`,
      messages: [
        { role: "user", content: `preview:${session.id}`, timestamp: 1 },
      ],
      hasOlder: false,
      olderCursor: null,
    },
    projectionHealth: { status: "ok" },
    availableModels: [],
    commands: [],
  };
}

function catalog(records: SessionRecord[]): SessionCatalogLike {
  const byId = new Map(records.map((item) => [item.id, item]));
  return {
    refresh: async () => records,
    get: async (id) => byId.get(id),
    getUnique: async (id) => {
      const matches = records.filter((record) => record.id === id);
      if (matches.length > 1)
        throw Object.assign(
          new Error("The session identity is ambiguous in the Pi catalog"),
          { status: 409 },
        );
      return matches[0];
    },
    list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
    listByIds: async () => [],
    listByCwds: async () => [],
    invalidate: () => undefined,
  };
}

const attachments: AttachmentStore[] = [];
const workspaceDirectories: string[] = [];

function upload(name: string, type: string): Express.Multer.File {
  const buffer = Buffer.from("payload");
  return {
    originalname: name,
    mimetype: type,
    size: buffer.length,
    buffer,
  } as Express.Multer.File;
}

afterEach(async () => {
  await Promise.all(attachments.splice(0).map((store) => store.close()));
  await Promise.all(
    workspaceDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("browser-safe runtime projection", () => {
  it("freezes one physical workspace root before starting slot-owned operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspire-runtime-workspace-"));
    workspaceDirectories.push(root);
    const physicalOne = join(root, "one");
    const physicalTwo = join(root, "two");
    const alias = join(root, "selected");
    await mkdir(physicalOne);
    await mkdir(physicalTwo);
    await writeFile(join(physicalOne, "marker.txt"), "one");
    await writeFile(join(physicalTwo, "marker.txt"), "two");
    await symlink(physicalOne, alias, "dir");
    const sessionPath = join(root, "a.jsonl");
    const session = record("a", alias);
    session.path = sessionPath;
    await writeFile(
      sessionPath,
      `${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: new Date().toISOString(), cwd: alias })}\n${JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hello", timestamp: 1 } })}\n`,
    );
    const store = new AttachmentStore();
    attachments.push(store);
    let worker: FakeRpc | undefined;
    const runtime = new RuntimeController(
      catalog([session]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
    );
    try {
      const initial = await runtime.openSession("a");
      const physical = await realpath(alias);
      await vi.waitFor(() => expect(worker?.starts).toBe(1));
      expect(physical).toBe(physicalOne);
      expect(worker?.options.cwd).toBe(physicalOne);
      expect(initial.active?.cwd).toBe(physicalOne);
      expect(runtime.sessionCwd("a")).toBe(physicalOne);

      await rm(alias);
      await symlink(physicalTwo, alias, "dir");
      await runtime.prompt({
        sessionId: "a",
        message: "use marker",
        projectFiles: ["marker.txt"],
      });
      const prompt = worker?.commands.find(
        (command) => command.type === "prompt",
      );
      expect(prompt?.message).toContain(join(physicalOne, "marker.txt"));
      expect(prompt?.message).not.toContain(join(physicalTwo, "marker.txt"));
      expect((await runtime.resourceContext("a")).cwd).toBe(physicalOne);
    } finally {
      await runtime.close();
    }
  });

  it("redacts credential-shaped fields and bounds oversized values", () => {
    const projected = safeProjection({
      authorization: "Bearer secret",
      nested: { apiKey: "secret", message: "x".repeat(250_001) },
      items: Array.from({ length: 10_001 }, (_, index) => index),
    }) as Record<string, unknown>;

    expect(projected.authorization).toBe("[redacted]");
    expect((projected.nested as Record<string, unknown>).apiKey).toBe(
      "[redacted]",
    );
    expect(
      String((projected.nested as Record<string, unknown>).message).endsWith(
        "…[truncated]",
      ),
    ).toBe(true);
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
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("open waited for worker")), 100),
      ),
    ]);
    expect(opened.active?.transcriptPage.messages).toEqual([
      { role: "user", content: "preview:a", timestamp: 1 },
    ]);
    await vi.waitFor(() => expect(worker.starts).toBe(1));

    const prompting = runtime.prompt({ sessionId: "a", message: "continue" });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(worker.commands.some((command) => command.type === "prompt")).toBe(
      false,
    );
    release();
    await prompting;
    expect(worker.commands.some((command) => command.type === "prompt")).toBe(
      true,
    );
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
    const prompting = runtime.prompt({
      sessionId: "a",
      message: "use the note",
      attachmentIds: [doc.id],
    });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    // The prompt owns the file while delivery waits on the worker; the
    // racing withdrawal must be moot.
    await store.remove(doc.id);
    release();
    await prompting;

    const promptCommand = worker.commands.find(
      (command) => command.type === "prompt",
    );
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
    const prompting = runtime.prompt({
      sessionId: "a",
      message: "first",
      attachmentIds: [doc.id],
    });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    await expect(
      runtime.prompt({
        sessionId: "a",
        message: "second",
        attachmentIds: [doc.id],
      }),
    ).rejects.toThrow(/already belong/);
    // Neither the rejected prompt's failure path nor a racing DELETE may
    // break the lease the first prompt still holds.
    await store.remove(doc.id);
    release();
    await prompting;

    const promptCommand = worker.commands.find(
      (command) => command.type === "prompt",
    );
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
    await expect(
      runtime.prompt({
        sessionId: "a",
        message: "use the note",
        attachmentIds: [doc.id],
      }),
    ).rejects.toThrow("prompt rejected");
    // Failed delivery restages the file: the withdrawal now works.
    await store.remove(doc.id);
    await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(/expired/);
    await runtime.close();
  });

  it("does not restage or duplicate attachments when prompt acceptance is unknown", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        const request = worker.request.bind(worker);
        worker.request = async <T>(command: Record<string, unknown>) => {
          if (command.type !== "prompt") return request<T>(command);
          worker.commands.push(command);
          const error = new PiRpcOutcomeUnknownError("prompt");
          error.stopped = Promise.resolve();
          throw error;
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await runtime.openSession("a");
    const doc = await store.add(upload("notes.txt", "text/plain"));
    await expect(
      runtime.prompt({
        sessionId: "a",
        message: "send once",
        attachmentIds: [doc.id],
      }),
    ).rejects.toThrow(/outcome is unknown/);
    expect(
      worker.commands.filter((command) => command.type === "prompt"),
    ).toHaveLength(1);
    await expect(
      runtime.prompt({
        sessionId: "a",
        message: "do not retry",
        attachmentIds: [doc.id],
      }),
    ).rejects.toThrow(/already belong/);
    expect(
      worker.commands.filter((command) => command.type === "prompt"),
    ).toHaveLength(1);
    await store.remove(doc.id);
    await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(
      /already belong/,
    );
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
    expect(
      workerA.commands.some(
        (command) =>
          command.type === "prompt" &&
          command.message === "background instruction",
      ),
    ).toBe(true);
    expect(
      workerA.commands.some(
        (command) =>
          command.type === "set_session_name" && command.name === "renamed A",
      ),
    ).toBe(true);
    expect(
      workerB?.commands.some((command) => command.type === "prompt") ?? false,
    ).toBe(false);
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

  it("does not change selection when a ready session's pre-commit snapshot fails", async () => {
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
    const slots = (
      runtime as unknown as { slots: Map<string, { ready: boolean }> }
    ).slots;
    await vi.waitFor(() => expect(slots.get("a")?.ready).toBe(true));
    await runtime.openSession("b");

    const workerA = workers.find((worker) => worker.sessionId === "a")!;
    const request = workerA.request.bind(workerA);
    workerA.request = async <T>(
      command: Record<string, unknown>,
    ): Promise<T> => {
      if (command.type === "get_state")
        throw new Error("snapshot failed before selection");
      return request<T>(command);
    };

    await expect(runtime.openSession("a")).rejects.toThrow(
      /snapshot failed before selection/,
    );
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
    const gate = new Promise<void>(
      (resolveGate) => (releaseSnapshot = resolveGate),
    );
    let snapshotStarted!: () => void;
    const started = new Promise<void>(
      (resolveStarted) => (snapshotStarted = resolveStarted),
    );
    const workerA = workers[0]!;
    const request = workerA.request.bind(workerA);
    workerA.request = async <T>(
      command: Record<string, unknown>,
    ): Promise<T> => {
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

  it("loads resource messages from the host projection without get_messages", async () => {
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
    worker.emit("event", {
      type: "message_update",
      message: { role: "assistant", timestamp: 2 },
    });

    const context = await runtime.resourceContext("a");
    expect(
      worker.commands.filter((command) => command.type === "get_messages"),
    ).toHaveLength(0);
    await context.loadMessages!();
    await context.loadMessages!();
    expect(
      worker.commands.filter((command) => command.type === "get_messages"),
    ).toHaveLength(0);
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
    await runtime.prompt({
      sessionId: "a",
      message: "accepted before agent_start",
    });
    await runtime.openSession("e");
    await runtime.openSession("f");

    await vi.waitFor(() =>
      expect(workers.find((worker) => worker.sessionId === "b")?.stops).toBe(1),
    );
    expect(workers.find((worker) => worker.sessionId === "a")?.stops).toBe(0);
    expect((await runtime.snapshot()).sessionStatuses.a).toMatchObject({
      runState: "queued",
      indicator: "running",
    });
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
    workerA.emit("event", {
      type: "extension_ui_request",
      id: "question-a",
      method: "confirm",
    });

    let releaseAck!: () => void;
    const ackGate = new Promise<void>(
      (resolveGate) => (releaseAck = resolveGate),
    );
    let ackStarted!: () => void;
    const started = new Promise<void>(
      (resolveStarted) => (ackStarted = resolveStarted),
    );
    const request = workerA.request.bind(workerA);
    workerA.request = async <T>(
      command: Record<string, unknown>,
    ): Promise<T> => {
      if (command.type === "get_state") {
        ackStarted();
        await ackGate;
      }
      return request<T>(command);
    };

    const responding = runtime.extensionUiResponse({
      sessionId: "a",
      id: "question-a",
      confirmed: true,
    });
    await started;
    await runtime.openSession("e");
    await runtime.openSession("f");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(workerA.stops).toBe(0);

    releaseAck();
    await responding;
    expect(workerA.uiResponses).toEqual([
      { id: "question-a", confirmed: true },
    ]);
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
    await runtime.prompt({
      sessionId: "a",
      message: "/compact focus on the parser work",
    });
    expect(
      worker.commands.find((command) => command.type === "compact"),
    ).toMatchObject({
      customInstructions: "focus on the parser work",
    });
    expect(worker.commands.some((command) => command.type === "prompt")).toBe(
      false,
    );

    // Only the exact command is intercepted; similar text still prompts.
    await runtime.prompt({
      sessionId: "a",
      message: "/compaction strategies?",
    });
    expect(worker.commands.some((command) => command.type === "prompt")).toBe(
      true,
    );
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
    await vi.waitFor(() => expect(previewCalls).toBe(1));
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
      catalog([
        record("a", "/project/one"),
        record("b", "/project/one"),
        record("c", "/project/two"),
      ]),
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
    expect(workers.map((worker) => worker.options.cwd)).toEqual([
      "/project/one",
      "/project/one",
      "/project/two",
    ]);
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
    workers[1]!.emit("event", {
      type: "extension_ui_request",
      id: "question-b",
      method: "confirm",
    });
    for (const id of ids.slice(2)) await runtime.openSession(id);

    await vi.waitFor(() =>
      expect(workers.filter((worker) => worker.stops === 0)).toHaveLength(
        MAX_IDLE_WORKERS + 3,
      ),
    );
    expect(workers[0]!.stops).toBe(0); // busy
    expect(workers[1]!.stops).toBe(0); // awaiting extension input
    expect(workers[2]!.stops).toBe(1); // oldest reclaimable idle worker

    workers[0]!.emit("event", { type: "agent_settled" });
    await runtime.extensionUiResponse({
      sessionId: "b",
      id: "question-b",
      confirmed: true,
    });
    await vi.waitFor(() =>
      expect(workers.filter((worker) => worker.stops === 0)).toHaveLength(
        MAX_IDLE_WORKERS + 1,
      ),
    );

    // Reopening a reclaimed session transparently starts one replacement,
    // after the previous process and sole projection have stopped.
    await runtime.openSession("c");
    await vi.waitFor(() =>
      expect(workers.filter((worker) => worker.sessionId === "c")).toHaveLength(
        2,
      ),
    );
    expect(
      workers
        .filter((worker) => worker.sessionId === "c")
        .map((worker) => worker.stops),
    ).toEqual([1, 0]);
    expect(previewCalls.get("c")).toBe(2);
    await runtime.close();
  });

  it("bounds dormant slots and status projection across hundreds of opens and reopens evicted sessions", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const ids = Array.from({ length: 240 }, (_, index) => `session-${index}`);
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
    for (const id of ids) await runtime.openSession(id);
    const slots = (runtime as unknown as { slots: Map<string, unknown> }).slots;
    await vi.waitFor(() =>
      expect(slots.size).toBeLessThanOrEqual(MAX_IDLE_WORKERS + 1),
    );
    const snapshot = await runtime.snapshot();
    expect(Object.keys(snapshot.sessionStatuses ?? {})).toHaveLength(
      slots.size,
    );
    expect(workers.filter((worker) => worker.stops === 0)).toHaveLength(
      MAX_IDLE_WORKERS + 1,
    );

    const reopened = await runtime.openSession(ids[0]!);
    expect(reopened.active?.sessionId).toBe(ids[0]);
    await vi.waitFor(() => expect(previewCalls.get(ids[0]!)).toBe(2));
    await vi.waitFor(() =>
      expect(slots.size).toBeLessThanOrEqual(MAX_IDLE_WORKERS + 1),
    );
    await runtime.close();
  }, 30_000);

  it("reclaims processless failed projections while retaining lightweight status across hundreds of exits", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const ids = Array.from({ length: 220 }, (_, index) => `failed-${index}`);
    const workers: FakeRpc[] = [];
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
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
    try {
      type ReclaimSlot = {
        projection: { close(): Promise<void> } | null;
        runState: string;
        ready: boolean;
      };
      const slots = (runtime as unknown as { slots: Map<string, ReclaimSlot> })
        .slots;
      let projectionsClosed = 0;
      for (const [index, id] of ids.entries()) {
        await runtime.openSession(id);
        await vi.waitFor(() => expect(slots.get(id)?.ready).toBe(true));
        const projection = slots.get(id)!.projection!;
        const close = projection.close.bind(projection);
        projection.close = async () => {
          projectionsClosed += 1;
          await close();
        };
        workers
          .find((worker) => worker.sessionId === id)!
          .emit("exit", new Error(`exit-${index}`));
      }
      await vi.waitFor(() =>
        expect(
          [...slots.values()].filter((slot) => slot.projection).length,
        ).toBeLessThanOrEqual(1),
      );
      expect(projectionsClosed).toBeGreaterThanOrEqual(ids.length - 1);
      expect(slots.size).toBe(ids.length);
      expect(
        [...slots.values()].every((slot) => slot.runState === "failed"),
      ).toBe(true);

      await runtime.openSession(ids[0]!);
      await vi.waitFor(() =>
        expect(
          workers.filter((worker) => worker.sessionId === ids[0]),
        ).toHaveLength(2),
      );
      expect(slots.get(ids[0]!)?.projection).toBeTruthy();
    } finally {
      errors.mockRestore();
      await runtime.close();
    }
  }, 30_000);

  it("reloads a reclaimed conflicted projection without starting a writer until abort clears policy", async () => {
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
    type InternalSlot = {
      projection: unknown;
      conflict: {
        kind: "projection-failure";
        message: string;
        revision: number;
      } | null;
      runState: string;
      attention: "failed" | null;
      ready: boolean;
    };
    const slots = (runtime as unknown as { slots: Map<string, InternalSlot> })
      .slots;
    try {
      await runtime.openSession("a");
      await vi.waitFor(() => expect(slots.get("a")?.ready).toBe(true));
      workers[0]!.emit("exit", new Error("conflicted exit"));
      const a = slots.get("a")!;
      a.conflict = {
        kind: "projection-failure",
        message: "retained conflict",
        revision: 1,
      };
      a.runState = "conflict";
      a.attention = "failed";

      await runtime.openSession("b");
      await vi.waitFor(() => expect(a.projection).toBeNull());
      await runtime.openSession("a");
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
      expect(a.projection).toBeTruthy();
      expect(a.conflict?.message).toBe("retained conflict");
      expect(workers.filter((worker) => worker.sessionId === "a")).toHaveLength(
        1,
      );

      await runtime.abort("a");
      expect(a.conflict).toBeNull();
      await runtime.prompt({ sessionId: "a", message: "after recovery" });
      await vi.waitFor(() =>
        expect(
          workers.filter((worker) => worker.sessionId === "a"),
        ).toHaveLength(2),
      );
    } finally {
      await runtime.close();
    }
  });

  it("keeps a reconciliation conflict sticky across agent settlement", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker: FakeRpc | undefined;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    type InternalSlot = {
      conflict: {
        kind: "external-change";
        message: string;
        revision: number;
      } | null;
      runState: string;
      ready: boolean;
    };
    const slots = (runtime as unknown as { slots: Map<string, InternalSlot> })
      .slots;
    try {
      await runtime.openSession("a");
      await vi.waitFor(() => expect(worker?.starts).toBe(1));
      const slot = slots.get("a")!;
      slot.conflict = {
        kind: "external-change",
        message: "Session changed on disk",
        revision: 2,
      };
      slot.runState = "conflict";
      worker!.emit("event", { type: "agent_settled" });
      await vi.waitFor(() => expect(worker?.stops).toBe(1));
      expect(slot.conflict).toEqual({
        kind: "external-change",
        message: "Session changed on disk",
        revision: 2,
      });
      expect(slot.runState).toBe("conflict");
      await expect(
        runtime.prompt({ sessionId: "a", message: "must not restart" }),
      ).rejects.toThrow("Session changed on disk");
      expect(worker?.starts).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("derives background conflict indicators after selection changes", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
    );
    type InternalSlot = {
      conflict: {
        kind: "external-change" | "projection-failure";
        message: string;
        revision: number;
      } | null;
      runState: string;
      attention: "completed" | "failed" | null;
    };
    const slots = (runtime as unknown as { slots: Map<string, InternalSlot> })
      .slots;
    try {
      await runtime.openSession("a");
      const a = slots.get("a")!;
      a.conflict = {
        kind: "external-change",
        message: "external update",
        revision: 2,
      };
      a.runState = "conflict";
      a.attention = null;
      expect((await runtime.snapshot()).sessionStatuses.a).toEqual({
        runState: "conflict",
      });

      const selectedB = await runtime.openSession("b");
      expect(selectedB.sessionStatuses.a).toEqual({
        runState: "conflict",
        indicator: "attention",
      });

      a.conflict = {
        kind: "projection-failure",
        message: "damaged projection",
        revision: 3,
      };
      expect((await runtime.snapshot()).sessionStatuses.a).toEqual({
        runState: "conflict",
        indicator: "failed",
      });
    } finally {
      await runtime.close();
    }
  });

  it("fails promptly and attributes a response-bearing startup UI request", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker: FakeRpc | undefined;
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.startupEvent = {
          type: "extension_ui_request",
          id: "startup-confirm",
          method: "confirm",
          title: "startup",
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      const started = Date.now();
      await expect(runtime.newSession("/tmp")).rejects.toThrow(
        PI_STARTUP_RESPONSE_UI_ERROR,
      );
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(worker?.stops).toBeGreaterThan(0);
      const internal = runtime as unknown as {
        slots: Map<string, unknown>;
        provisionalSlots: Map<string, unknown>;
      };
      expect(internal.slots.size).toBe(0);
      expect(internal.provisionalSlots.size).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("allows fire-and-forget startup UI while rejecting no startup response", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker: FakeRpc | undefined;
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.startupEvent = {
          type: "extension_ui_request",
          id: "startup-notify",
          method: "notify",
          message: "ready",
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      const snapshot = await runtime.newSession("/tmp");
      expect(snapshot.active?.sessionId).toBe("new-id");
      expect(worker?.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("does not perform a fallible authoritative snapshot after committing a new session", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
    );
    const internals = runtime as unknown as {
      snapshotSlot(slot: unknown): Promise<unknown>;
    };
    internals.snapshotSlot = async () => {
      throw new Error("post-commit snapshot must not run");
    };
    try {
      const snapshot = await runtime.newSession("/tmp");
      expect(snapshot.active?.sessionId).toBe("new-id");
      expect(runtime.activeSessionId).toBe("new-id");
    } finally {
      await runtime.close();
    }
  });

  it("starts a new Pi worker with the selected model and thinking level", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker: FakeRpc | undefined;
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        // Match Pi's normal new-session behavior: it reserves a JSONL pathname
        // before the first prompt, but has not written a thinking-level entry.
        worker.sessionPath = "/tmp/new-id.jsonl";
        const request = worker.request.bind(worker);
        worker.request = async <T>(
          command: Record<string, unknown>,
        ): Promise<T> => {
          const result = await request<T>(command);
          return command.type === "get_state"
            ? ({
                ...(result as object),
                thinkingLevel: "high",
                model: { provider: "anthropic", id: "claude-sonnet-4" },
              } as T)
            : result;
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      const snapshot = await runtime.newSession("/tmp", {
        name: "  Tuned session  ",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        thinkingLevel: "high",
      });
      expect(worker?.options.args).toEqual(
        expect.arrayContaining([
          "--name",
          "Tuned session",
          "--model",
          "anthropic/claude-sonnet-4",
          "--thinking",
          "high",
        ]),
      );
      expect(worker?.options.args?.at(-2)).toBe("--extension");
      expect(snapshot.active).toMatchObject({
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        thinkingLevel: "high",
      });
      // A later snapshot previously painted the pending projection's `off`
      // default while its explicit --thinking selection still awaited JSONL.
      expect((await runtime.snapshot()).active).toMatchObject({
        thinkingLevel: "high",
      });
    } finally {
      await runtime.close();
    }
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
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );

    await runtime.openSession("a");
    await runtime.openSession("b");
    workers[0]!.emit("event", { type: "agent_start" });
    expect((await runtime.snapshot()).sessionStatuses.a).toEqual({
      runState: "running",
      indicator: "running",
    });

    workers[0]!.emit("event", { type: "agent_settled" });
    await vi.waitFor(async () => {
      expect((await runtime.snapshot()).sessionStatuses.a).toEqual({
        runState: "idle",
        indicator: "completed",
      });
    });
    expect(events.at(-1)).toMatchObject({
      type: "agent_settled",
      sessionId: "a",
      sessionStatus: { indicator: "completed" },
    });

    await runtime.openSession("a");
    expect((await runtime.snapshot()).sessionStatuses.a).toEqual({
      runState: "idle",
    });

    workers[1]!.emit("event", { type: "agent_start" });
    workers[1]!.emit("event", {
      type: "message_end",
      message: { role: "assistant", stopReason: "error" },
    });
    workers[1]!.emit("event", { type: "agent_settled" });
    expect((await runtime.snapshot()).sessionStatuses.b).toEqual({
      runState: "failed",
      indicator: "failed",
    });

    await runtime.openSession("b");
    expect((await runtime.snapshot()).sessionStatuses.b).toEqual({
      runState: "failed",
    });
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
    worker.emit("event", {
      type: "extension_ui_request",
      id: "question-1",
      method: "confirm",
    });
    worker.emit("exit", new Error("worker crashed"));

    const recovered = await runtime.snapshot();
    expect(recovered.active?.transcriptPage.messages).toEqual([
      { role: "user", content: "preview:a", timestamp: 1 },
    ]);
    expect(recovered.runState).toBe("failed");
    expect(recovered.pendingExtensionUiRequests).toEqual([]);
    expect(recovered.sessionStatuses.a).toEqual({ runState: "failed" });
    await runtime.close();
  });

  it("snapshots exact pending queues for reconnect and clears them on settle and worker replacement", async () => {
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

    worker.emit("event", {
      type: "queue_update",
      steering: ["first", "second"],
      followUp: ["later"],
    });
    expect((await runtime.snapshot()).pendingQueues).toEqual({
      steering: ["first", "second"],
      followUp: ["later"],
    });

    worker.emit("event", { type: "agent_settled" });
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).pendingQueues).toEqual({
        steering: [],
        followUp: [],
      }),
    );

    worker.emit("event", {
      type: "queue_update",
      steering: ["stale"],
      followUp: [],
    });
    worker.emit("exit", new Error("replacement required"));
    expect((await runtime.snapshot()).pendingQueues).toEqual({
      steering: [],
      followUp: [],
    });
    await runtime.close();
  });

  it("retains generic extension display content and cancels unknown interactive methods", async () => {
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

    worker.emit("event", {
      type: "extension_ui_request",
      id: "widget-1",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["one", "two"],
      extensionPath: "/extensions/plan.ts",
      body: "x".repeat(140 * 1024),
      apiToken: "must not cross",
    });
    let snapshot = await runtime.snapshot();
    expect(snapshot.extensionDisplays).toEqual([
      expect.objectContaining({
        id: "setWidget:plan",
        attribution: "/extensions/plan.ts · plan",
        payload: expect.objectContaining({ truncated: true }),
      }),
    ]);
    expect(JSON.stringify(snapshot.extensionDisplays)).not.toContain(
      "must not cross",
    );
    expect(snapshot.pendingExtensionUiRequests).toEqual([]);

    worker.emit("event", {
      type: "extension_ui_request",
      id: "future-dialog",
      method: "chooseFiles",
      title: "Choose files",
      paths: ["a", "b"],
    });
    snapshot = await runtime.snapshot();
    expect(snapshot.pendingExtensionUiRequests).toEqual([
      expect.objectContaining({
        id: "future-dialog",
        method: "chooseFiles",
        unsupported: true,
      }),
    ]);
    await runtime.extensionUiResponse({
      sessionId: "a",
      id: "future-dialog",
      cancelled: true,
    });
    expect(worker.uiResponses).toContainEqual({
      id: "future-dialog",
      cancelled: true,
    });
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
    await runtime.close();
  });

  it("preserves concurrent dialogs, mirrors expiry, and clears every request at lifecycle boundaries", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker!: FakeRpc;
    const emitted: Array<Record<string, unknown>> = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    runtime.on("event", (event) =>
      emitted.push(event as Record<string, unknown>),
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));

    worker.emit("event", {
      type: "extension_ui_request",
      id: "first",
      method: "confirm",
      timeout: 100,
    });
    worker.emit("event", {
      type: "extension_ui_request",
      id: "second",
      method: "input",
    });
    let snapshot = await runtime.snapshot();
    expect(
      snapshot.pendingExtensionUiRequests?.map((request) => request.id),
    ).toEqual(["first", "second"]);
    expect(snapshot.pendingExtensionUiRequests?.[0]?.timeout).toBe(100);
    expect(snapshot.pendingExtensionUiRequests?.[0]?.expiresAt).toBeGreaterThan(
      Date.now(),
    );

    await new Promise((resolveTimer) => setTimeout(resolveTimer, 120));
    snapshot = await runtime.snapshot();
    expect(
      snapshot.pendingExtensionUiRequests?.map((request) => request.id),
    ).toEqual(["second"]);
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "extension_ui_remove",
        id: "first",
        reason: "expired",
      }),
    );
    await expect(
      runtime.extensionUiResponse({
        sessionId: "a",
        id: "first",
        confirmed: true,
      }),
    ).rejects.toThrow(/no longer pending/);
    expect(worker.uiResponses).not.toContainEqual(
      expect.objectContaining({ id: "first" }),
    );

    await runtime.extensionUiResponse({
      sessionId: "a",
      id: "second",
      value: "answer",
    });
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
    worker.emit("event", {
      type: "extension_ui_request",
      id: "abort-a",
      method: "confirm",
      timeout: 1_000,
    });
    worker.emit("event", {
      type: "extension_ui_request",
      id: "abort-b",
      method: "confirm",
    });
    await runtime.abort("a");
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);

    worker.emit("event", {
      type: "extension_ui_request",
      id: "settle-a",
      method: "confirm",
    });
    worker.emit("event", {
      type: "extension_ui_request",
      id: "settle-b",
      method: "confirm",
    });
    worker.emit("event", { type: "agent_settled" });
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);

    worker.emit("event", {
      type: "extension_ui_request",
      id: "replacement",
      method: "confirm",
      timeout: 1_000,
    });
    worker.emit("exit", new Error("replace worker"));
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
    await runtime.close();
  });

  it("treats a written extension response with a lost ordered fence as acceptance-unknown", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker!: FakeRpc;
    let responseWritten = false;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        const send = worker.sendExtensionUiResponse.bind(worker);
        worker.sendExtensionUiResponse = (response) => {
          send(response);
          responseWritten = true;
        };
        const request = worker.request.bind(worker);
        worker.request = async <T>(command: Record<string, unknown>) => {
          if (responseWritten && command.type === "get_state") {
            const error = new PiRpcOutcomeUnknownError("get_state");
            error.stopped = Promise.resolve();
            throw error;
          }
          return request<T>(command);
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    worker.emit("event", {
      type: "extension_ui_request",
      id: "unknown-ui",
      method: "confirm",
    });
    await expect(
      runtime.extensionUiResponse({
        sessionId: "a",
        id: "unknown-ui",
        confirmed: true,
      }),
    ).rejects.toThrow(/outcome is unknown/);
    expect(worker.uiResponses).toEqual([{ id: "unknown-ui", confirmed: true }]);
    expect(worker.stops).toBe(1);
    expect((await runtime.snapshot()).runState).toBe("conflict");
    await expect(
      runtime.extensionUiResponse({
        sessionId: "a",
        id: "unknown-ui",
        confirmed: true,
      }),
    ).rejects.toThrow();
    expect(worker.uiResponses).toHaveLength(1);
    await runtime.close();
  });

  it("retires the writer when extension-response stdin delivery is acceptance-unknown", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.sendExtensionUiResponse = async () => {
          const error = new PiRpcOutcomeUnknownError("extension_ui_response");
          error.stopped = Promise.resolve();
          throw error;
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    worker.emit("event", {
      type: "extension_ui_request",
      id: "unknown-write",
      method: "confirm",
    });
    await expect(
      runtime.extensionUiResponse({
        sessionId: "a",
        id: "unknown-write",
        confirmed: true,
      }),
    ).rejects.toThrow(/outcome is unknown/);
    expect(worker.stops).toBe(1);
    expect((await runtime.snapshot()).runState).toBe("conflict");
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
    const slots = (
      runtime as unknown as { slots: Map<string, { ready: boolean }> }
    ).slots;
    await vi.waitFor(() => expect(slots.get("a")?.ready).toBe(true));
    await vi.waitFor(() => expect(slots.get("b")?.ready).toBe(true));
    workers[0]!.emit("event", {
      type: "extension_ui_request",
      id: "question-1",
      method: "confirm",
      title: "Proceed?",
      message: "Confirm the operation",
    });
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);

    const restored = await runtime.openSession("a");
    expect(restored.pendingExtensionUiRequests).toEqual([
      {
        sessionId: "a",
        id: "question-1",
        method: "confirm",
        title: "Proceed?",
        message: "Confirm the operation",
      },
    ]);
    await runtime.openSession("b");
    await runtime.extensionUiResponse({
      sessionId: "a",
      id: "question-1",
      value: true,
    });
    expect(workers[0]!.uiResponses).toEqual([
      { id: "question-1", value: true },
    ]);
    expect(workers[1]!.uiResponses).toEqual([]);
    expect((await runtime.openSession("a")).pendingExtensionUiRequests).toEqual(
      [],
    );
    await runtime.close();
  });

  it("owns and drains a provisional new-session worker during concurrent close", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker!: FakeRpc;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolveStart) => {
      releaseStart = resolveStart;
    });
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.startGate = startGate;
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    const creating = runtime.newSession("/tmp");
    await vi.waitFor(() => expect(worker?.starts).toBe(1));
    const closing = runtime.close();
    await vi.waitFor(() => expect(worker.stops).toBe(1));
    await expect(runtime.newSession("/tmp")).rejects.toThrow(/closing/);
    releaseStart();
    await expect(creating).rejects.toThrow(/closing/);
    await expect(closing).resolves.toBeUndefined();
    const internal = runtime as unknown as {
      slots: Map<string, unknown>;
      provisionalSlots: Map<string, unknown>;
    };
    expect(internal.slots.size).toBe(0);
    expect(internal.provisionalSlots.size).toBe(0);
    expect(worker.stops).toBe(1);
  });

  it("atomically cleans a provisional identity-rebind race and startup failure", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const workers: FakeRpc[] = [];
    let releaseIdentity!: () => void;
    const identityGate = new Promise<void>((resolveIdentity) => {
      releaseIdentity = resolveIdentity;
    });
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        const request = worker.request.bind(worker);
        worker.request = async <T>(command: Record<string, unknown>) => {
          const result = await request<T>(command);
          if (command.type === "get_state") await identityGate;
          return result;
        };
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    const creating = runtime.newSession("/tmp");
    await vi.waitFor(() =>
      expect(
        workers[0]?.commands.some((command) => command.type === "get_state"),
      ).toBe(true),
    );
    const closing = runtime.close();
    await vi.waitFor(() => expect(workers[0]?.stops).toBe(1));
    releaseIdentity();
    await expect(creating).rejects.toThrow(/closing/);
    await closing;
    const internal = runtime as unknown as {
      slots: Map<string, unknown>;
      provisionalSlots: Map<string, unknown>;
    };
    expect(internal.slots.size).toBe(0);
    expect(internal.provisionalSlots.size).toBe(0);
    expect(workers.reduce((sum, worker) => sum + worker.starts, 0)).toBe(1);
    expect(workers.reduce((sum, worker) => sum + worker.stops, 0)).toBe(1);
  });

  it("unregisters and stops a provisional worker whose startup fails", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.start = async () => {
          worker.starts += 1;
          throw new Error("startup failed");
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await expect(runtime.newSession("/tmp")).rejects.toThrow(/startup failed/);
    const internal = runtime as unknown as {
      slots: Map<string, unknown>;
      provisionalSlots: Map<string, unknown>;
    };
    expect(internal.slots.size).toBe(0);
    expect(internal.provisionalSlots.size).toBe(0);
    expect(worker.starts).toBe(1);
    expect(worker.stops).toBe(1);
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
        const request = worker.request.bind(worker);
        worker.request = async <T>(
          command: Record<string, unknown>,
        ): Promise<T> => {
          const result = await request<T>(command);
          if (command.type === "get_state") {
            // Arrives after RPC startup while the slot still carries its
            // provisional identity.
            worker.emit("event", {
              type: "extension_ui_request",
              id: "trust-1",
              method: "confirm",
              title: "Trust?",
            });
          }
          return result;
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );

    const created = await runtime.newSession("/tmp");
    expect(created.active?.sessionId).toBe("new-id");
    expect(created.pendingExtensionUiRequests).toEqual([
      expect.objectContaining({
        sessionId: "new-id",
        id: "trust-1",
        method: "confirm",
      }),
    ]);
    // No event may ever leave the host addressed to a pending-* session.
    expect(
      events.every(
        (event) => !String(event.sessionId ?? "").startsWith("pending-"),
      ),
    ).toBe(true);
    await runtime.extensionUiResponse({
      sessionId: "new-id",
      id: "trust-1",
      value: true,
    });
    expect(worker.uiResponses).toEqual([{ id: "trust-1", value: true }]);
    await runtime.close();
  });

  it("deletes an unopened catalog session through the injected destructive boundary", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const source = catalog([record("a", "/tmp")]);
    source.refresh = vi.fn(source.refresh);
    source.invalidate = vi.fn();
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      source,
      store,
      undefined,
      preview,
      15_000,
      undefined,
      remove,
    );

    await expect(runtime.deleteSession("a")).resolves.toEqual({
      sessionId: "a",
      disposition: "trashed",
    });
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", path: "/sessions/a.jsonl" }),
    );
    expect(source.refresh).not.toHaveBeenCalled();
    expect(source.invalidate).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("deletes the complete hidden-folder snapshot after reserving every identity", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const source = catalog([record("a", "/tmp"), record("b", "/tmp")]);
    source.refresh = vi.fn(source.refresh);
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      source,
      store,
      undefined,
      preview,
      15_000,
      undefined,
      remove,
    );

    await expect(
      runtime.deleteHiddenFolderSessions("/tmp", ["a", "b"]),
    ).resolves.toEqual({
      cwd: "/tmp",
      deleted: [
        { sessionId: "a", disposition: "trashed" },
        { sessionId: "b", disposition: "trashed" },
      ],
    });
    expect(source.refresh).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it("rejects a Hidden-folder batch if its reviewed session snapshot changed", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      store,
      undefined,
      preview,
      15_000,
      undefined,
      remove,
    );

    await expect(
      runtime.deleteHiddenFolderSessions("/tmp", ["a"]),
    ).rejects.toMatchObject({
      status: 409,
      message: "The folder's sessions changed; review it before deleting",
    });
    expect(remove).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("rejects a Hidden-folder batch before moving any session when one is selected", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
      15_000,
      undefined,
      remove,
    );
    await runtime.openSession("a");

    await expect(
      runtime.deleteHiddenFolderSessions("/tmp", ["a", "b"]),
    ).rejects.toMatchObject({
      status: 409,
      message: "Switch to another session before deleting this folder",
    });
    expect(remove).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("refuses an ambiguous catalog identity before touching either file", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const first = record("a", "/tmp");
    const second = {
      ...record("a", "/other"),
      path: "/sessions/copied-a.jsonl",
    };
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([first, second]),
      store,
      undefined,
      preview,
      15_000,
      undefined,
      remove,
    );

    await expect(runtime.deleteSession("a")).rejects.toMatchObject({
      message: "The session identity is ambiguous in the Pi catalog",
      status: 409,
    });
    expect(remove).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("refuses to delete the selected session before touching its file", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
      15_000,
      undefined,
      remove,
    );

    await runtime.openSession("a");
    await expect(runtime.deleteSession("a")).rejects.toMatchObject({
      message: "Switch to another session before deleting this one",
      status: 409,
    });
    expect(remove).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("makes the prior idle session deletable after New session deselects host ownership", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
      15_000,
      undefined,
      remove,
    );

    await runtime.openSession("a");
    const deselected = await runtime.deselectSession();
    expect(deselected.active).toBeNull();
    expect(runtime.activeSessionId).toBeNull();
    await expect(runtime.deleteSession("a")).resolves.toEqual({
      sessionId: "a",
      disposition: "trashed",
    });
    expect(remove).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("refuses to delete an unselected session while its agent is still running", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const workers = new Map<string, FakeRpc>();
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.set(worker.sessionId, worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
      15_000,
      undefined,
      remove,
    );

    await runtime.openSession("a");
    await vi.waitFor(() => expect(workers.get("a")?.starts).toBe(1));
    workers.get("a")!.emit("event", { type: "agent_start" });
    await runtime.openSession("b");
    await expect(runtime.deleteSession("a")).rejects.toMatchObject({
      status: 409,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(workers.get("a")?.stops).toBe(0);
    await runtime.close();
  });

  it("stops and retires an idle unselected worker before deleting its file", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const workers = new Map<string, FakeRpc>();
    const remove = vi.fn(async () => "deleted" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.set(worker.sessionId, worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
      15_000,
      undefined,
      remove,
    );

    await runtime.openSession("a");
    await vi.waitFor(() => expect(workers.get("a")?.starts).toBe(1));
    await runtime.openSession("b");
    await vi.waitFor(() => expect(workers.get("b")?.starts).toBe(1));
    const internal = runtime as unknown as {
      slots: Map<string, { activeOperations: number }>;
    };
    await vi.waitFor(() =>
      expect(internal.slots.get("a")?.activeOperations).toBe(0),
    );

    await expect(runtime.deleteSession("a")).resolves.toEqual({
      sessionId: "a",
      disposition: "deleted",
    });
    expect(workers.get("a")?.stops).toBe(1);
    expect(runtime.sessionCwd("a")).toBeNull();
    expect(remove).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("blocks new opens while a deletion outcome is in flight", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let entered = false;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
      15_000,
      undefined,
      async () => {
        entered = true;
        await gate;
        return "trashed";
      },
    );

    const deleting = runtime.deleteSession("a");
    await vi.waitFor(() => expect(entered).toBe(true));
    await expect(runtime.openSession("a")).rejects.toMatchObject({
      message: "That session is being deleted",
      status: 409,
    });
    release();
    await expect(deleting).resolves.toEqual({
      sessionId: "a",
      disposition: "trashed",
    });
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
    await runtime.prompt({
      sessionId: "a",
      message: "use these",
      attachmentIds: [image.id, file.id],
    });
    // Image bytes travelled inside the prompt request; the cache entry is gone.
    await expect(store.resolveForPrompt([image.id])).rejects.toThrow(/expired/);
    // The ordinary file's host path is referenced by the conversation text:
    // it stays readable on disk, but cannot join a second message.
    const promptCommand = worker.commands.find(
      (command) => command.type === "prompt",
    );
    const referenced = String(promptCommand?.message ?? "").split("\n- ")[1];
    expect(referenced).toContain("notes.txt");
    await expect(access(referenced!)).resolves.toBeUndefined();
    await expect(store.resolveForPrompt([file.id])).rejects.toThrow(
      /already belong/,
    );
    await runtime.close();
  });
});

describe("maintenance restart admission", () => {
  it("fences every new runtime command after an idle lease", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
    );

    const decision = runtime.reserveMaintenanceRestart();
    expect(decision.kind).toBe("ready");
    await expect(runtime.newSession("/tmp")).rejects.toMatchObject({
      status: 503,
    });
    await runtime.close();
  });

  it("does not grant a lease while an open request is still in flight", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const reachedPreview = new Promise<void>((resolveEntered) => {
      entered = resolveEntered;
    });
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      async (session) => {
        entered();
        await gate;
        return preview(session);
      },
    );

    const opening = runtime.openSession("a");
    await reachedPreview;
    expect(runtime.reserveMaintenanceRestart()).toEqual({
      kind: "busy",
      reason: "in-flight-operation",
    });
    release();
    await opening;
    await runtime.close();
  });
});
