import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentStore,
  addAttachmentContext,
} from "../../server/attachments.js";
import {
  type PiRpcOptions,
  PiRpcOutcomeUnknownError,
  type PiRpcProcess,
} from "../../server/pi-rpc.js";
import {
  MAX_IDLE_WORKERS,
  PI_STARTUP_RESPONSE_UI_ERROR,
  RuntimeController,
  safeProjection,
} from "../../server/runtime.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";
import type { ActiveSessionSnapshot } from "../../server/session-preview.js";
import {
  MAX_EXTENSION_KEY_CHARS,
  MAX_EXTENSION_STATUS_CHARS,
} from "../../shared/contracts.js";

class FakeRpc extends EventEmitter {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly uiResponses: Array<Record<string, unknown>> = [];
  starts = 0;
  stops = 0;
  failPrompts = false;
  readonly responseOverrides = new Map<string, unknown>();
  startupEvent: Record<string, unknown> | null = null;
  startGate: Promise<void> | null = null;
  sessionPath: string | null;
  sessionId: string;

  get available(): boolean {
    return true;
  }

  constructor(readonly options: PiRpcOptions) {
    super();
    const marker = options.args?.indexOf("--session") ?? -1;
    this.sessionPath = marker >= 0 ? resolve(options.args![marker + 1]!) : null;
    this.sessionId = this.sessionPath
      ? basename(this.sessionPath, ".jsonl")
      : "new-id";
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
    if (
      typeof command.type === "string" &&
      this.responseOverrides.has(command.type)
    ) {
      const override = this.responseOverrides.get(command.type);
      const value =
        typeof override === "function"
          ? (override as (command: Record<string, unknown>) => unknown)(command)
          : structuredClone(override);
      return value as T;
    }
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

function pendingEntry(id: string, text: string) {
  return {
    id,
    textPreview: text,
    textLength: text.length,
    textTruncated: false,
    imageCount: 0,
    nonTextContentCount: 0,
  };
}

function pendingState(
  steering: string[] = [],
  followUp: string[] = [],
  options: { paused?: boolean; revision?: number } = {},
) {
  return {
    paused: options.paused ?? false,
    revision: options.revision ?? 0,
    steering: steering.map((text, index) =>
      pendingEntry(`steer-${index + 1}`, text),
    ),
    followUp: followUp.map((text, index) =>
      pendingEntry(`follow-${index + 1}`, text),
    ),
  };
}

const TEST_CWD = realpathSync(tmpdir());
const HIDDEN_FOLDER_CWD = resolve("/folder");

function record(id: string, cwd: string): SessionRecord {
  return {
    id,
    cwd: cwd === "/tmp" ? TEST_CWD : resolve(cwd),
    path: resolve("/sessions", `${id}.jsonl`),
    source: null,
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
    get: async (id) => {
      const matches = records.filter((record) => record.id === id);
      if (matches.length > 1)
        throw Object.assign(
          new Error("The session identity is ambiguous in the Pi catalog"),
          { status: 409 },
        );
      return byId.get(id);
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
  it.runIf(process.platform !== "win32")(
    "freezes one physical workspace root before starting slot-owned operations",
    async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "inspire-runtime-workspace-")),
      );
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
    },
  );

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

  it("revalidates project-file authority after gated worker startup", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "inspire-runtime-project-revalidate-"),
    );
    workspaceDirectories.push(workspace);
    const selected = join(workspace, "selected.txt");
    await writeFile(selected, "selected");
    const store = new AttachmentStore();
    attachments.push(store);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", workspace)]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.startGate = gate;
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );

    try {
      await runtime.openSession("a");
      await vi.waitFor(() => expect(worker.starts).toBe(1));
      const prompting = runtime.prompt({
        sessionId: "a",
        message: "use the selected file",
        projectFiles: ["selected.txt"],
      });
      const slots = (
        runtime as unknown as {
          slots: Map<string, { mutationPending: number }>;
        }
      ).slots;
      await vi.waitFor(() => expect(slots.get("a")?.mutationPending).toBe(2));

      await rm(selected);
      release();
      await expect(prompting).rejects.toMatchObject({
        status: 409,
        message: "A selected project file changed before prompt delivery",
      });
      expect(worker.commands.some((command) => command.type === "prompt")).toBe(
        false,
      );
    } finally {
      release();
      await runtime.close();
    }
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
    const referenced = JSON.parse(
      String(promptCommand?.message ?? "").split("\n- ")[1]!,
    ) as string;
    expect(referenced).toContain("notes.txt");
    await expect(access(referenced)).resolves.toBeUndefined();
    // Consumed after delivery: a late DELETE is equally moot.
    await store.remove(doc.id);
    await expect(access(referenced)).resolves.toBeUndefined();
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
    const referenced = JSON.parse(
      String(promptCommand?.message ?? "").split("\n- ")[1]!,
    ) as string;
    await expect(access(referenced)).resolves.toBeUndefined();
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

  it("acknowledges an accepted prompt when its immediate projection refresh fails", async () => {
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
    const slots = (
      runtime as unknown as {
        slots: Map<
          string,
          {
            projection: {
              reconcile: (force?: boolean) => Promise<unknown>;
            } | null;
          }
        >;
      }
    ).slots;
    const request = worker.request.bind(worker);
    worker.request = async <T>(command: Record<string, unknown>) => {
      const result = await request<T>(command);
      if (command.type === "prompt") {
        const projection = slots.get("a")!.projection!;
        const reconcile = projection.reconcile.bind(projection);
        projection.reconcile = async () => {
          projection.reconcile = reconcile;
          throw new Error("projection read failed");
        };
      }
      return result;
    };

    await expect(
      runtime.prompt({ sessionId: "a", message: "accepted once" }),
    ).resolves.toBeNull();
    expect(
      worker.commands.filter((command) => command.type === "prompt"),
    ).toHaveLength(1);
    expect(worker.stops).toBe(1);
    expect((await runtime.snapshot()).active?.projectionConflict).toMatchObject(
      {
        kind: "projection-failure",
      },
    );
    await runtime.close();
  });

  it("does not reject an accepted prompt when optional Composer-history hydration fails", async () => {
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
    const slot = (
      runtime as unknown as {
        slots: Map<
          string,
          {
            projection: {
              composerHistoryPage: (...args: unknown[]) => unknown;
            } | null;
          }
        >;
      }
    ).slots.get("a")!;
    const request = worker.request.bind(worker);
    worker.request = async <T>(command: Record<string, unknown>) => {
      const result = await request<T>(command);
      if (command.type === "prompt") {
        slot.projection!.composerHistoryPage = () => {
          throw new Error("history projection failed");
        };
      }
      return result;
    };

    await expect(
      runtime.prompt({ sessionId: "a", message: "accepted once" }),
    ).resolves.toBeNull();
    expect(
      worker.commands.filter((command) => command.type === "prompt"),
    ).toHaveLength(1);
    expect(worker.stops).toBe(0);
    await runtime.close();
  });

  it("stops a worker when terminal-event projection reconciliation fails", async () => {
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
    await runtime.prompt({ sessionId: "a", message: "accepted" });
    const slot = (
      runtime as unknown as {
        slots: Map<
          string,
          {
            projection: {
              reconcile: (force?: boolean) => Promise<unknown>;
            } | null;
          }
        >;
      }
    ).slots.get("a")!;
    const projection = slot.projection!;
    const reconcile = projection.reconcile.bind(projection);
    projection.reconcile = async () => {
      projection.reconcile = reconcile;
      throw new Error("terminal projection read failed");
    };

    worker.emit("event", { type: "agent_settled" });
    await vi.waitFor(() => expect(worker.stops).toBe(1));
    expect((await runtime.snapshot()).active?.projectionConflict).toMatchObject(
      {
        kind: "projection-failure",
      },
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

  it("resends all recalled prompt artifacts from the current branch view", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "inspire-history-artifacts-")),
    );
    workspaceDirectories.push(root);
    const workspace = join(root, "project");
    const projectFile = join(workspace, "source.ts");
    await mkdir(workspace);
    await writeFile(projectFile, "project");
    const store = new AttachmentStore();
    attachments.push(store);
    const uploaded = await store.add(upload("report.pdf", "application/pdf"));
    const leased = await store.resolveForPrompt([uploaded.id]);
    const attachmentFile = leased.files[0]!.path;
    await store.releaseConsumed([uploaded.id]);
    let worker!: FakeRpc;
    const data = Buffer.from("historical pixels").toString("base64");
    const historicalText = addAttachmentContext(
      "original",
      [{ kind: "file", path: attachmentFile }],
      [projectFile],
    );
    const runtime = new RuntimeController(
      catalog([record("a", workspace)]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      async (session) => {
        const value = await preview(session);
        return {
          ...value,
          transcriptPage: {
            ...value.transcriptPage,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: historicalText },
                  { type: "image", data, mimeType: "image/png" },
                ],
                timestamp: 1,
              },
            ],
          },
        };
      },
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    const history = await runtime.composerHistory("a", 0);
    const entry = history.entries[0]!;
    expect(entry.images[0]?.reference).toBe("pi-embedded://0/1");
    expect(entry.files).toEqual([
      {
        reference: "pi-file://0/0",
        fileName: "source.ts",
        kind: "project",
      },
      {
        reference: "pi-file://0/1",
        fileName: "report.pdf",
        kind: "attachment",
      },
    ]);

    await expect(
      runtime.prompt({
        sessionId: "a",
        message: "forged",
        historyArtifacts: {
          viewId: "another-view",
          incarnation: history.incarnation ?? null,
          effectiveLeafId: history.effectiveLeafId ?? null,
          imageReferences: entry.images.map((image) => image.reference),
          fileReferences: entry.files.map((file) => file.reference),
        },
      }),
    ).rejects.toMatchObject({ status: 409 });

    await runtime.prompt({
      sessionId: "a",
      message: "again",
      historyArtifacts: {
        viewId: history.viewId,
        incarnation: history.incarnation ?? null,
        effectiveLeafId: history.effectiveLeafId ?? null,
        imageReferences: entry.images.map((image) => image.reference),
        fileReferences: entry.files.map((file) => file.reference),
      },
    });
    expect(
      worker.commands.find((command) => command.type === "prompt"),
    ).toMatchObject({
      message: addAttachmentContext(
        "again",
        [{ kind: "file", path: attachmentFile }],
        [projectFile],
      ),
      images: [{ type: "image", data, mimeType: "image/png" }],
    });
    await runtime.close();
  });

  it("rejects a forged recalled attachment path outside the active workspace", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "inspire-forged-history-")),
    );
    workspaceDirectories.push(root);
    const workspace = join(root, "project");
    const forgedFile = join(root, "host-secret.txt");
    await mkdir(workspace);
    await writeFile(forgedFile, "not an uploaded attachment");
    const store = new AttachmentStore();
    attachments.push(store);
    let worker!: FakeRpc;
    const historicalText = addAttachmentContext(
      "open the report",
      [{ kind: "file", path: forgedFile }],
      [],
    );
    const runtime = new RuntimeController(
      catalog([record("a", workspace)]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      async (session) => {
        const value = await preview(session);
        return {
          ...value,
          transcriptPage: {
            ...value.transcriptPage,
            messages: [{ role: "user", content: historicalText, timestamp: 1 }],
          },
        };
      },
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    const history = await runtime.composerHistory("a", 0);
    const entry = history.entries[0]!;
    expect(entry.files).toEqual([
      {
        reference: "pi-file://0/0",
        fileName: "host-secret.txt",
        kind: "attachment",
      },
    ]);

    await expect(
      runtime.prompt({
        sessionId: "a",
        message: "send it again",
        historyArtifacts: {
          viewId: history.viewId,
          incarnation: history.incarnation ?? null,
          effectiveLeafId: history.effectiveLeafId ?? null,
          imageReferences: [],
          fileReferences: entry.files.map((file) => file.reference),
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      worker.commands.filter((command) => command.type === "prompt"),
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
      resolve("/project/one"),
      resolve("/project/one"),
      resolve("/project/two"),
    ]);
    expect(workers.every((worker) => worker.stops === 0)).toBe(true);

    await runtime.openSession("a");
    expect(workers).toHaveLength(3);
    expect(workers.every((worker) => worker.stops === 0)).toBe(true);

    await runtime.close();
    expect(workers.every((worker) => worker.stops === 1)).toBe(true);
  });

  it("bounds the idle worker cache without stopping busy, paused, or extension-blocked sessions", async () => {
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
    await runtime.openSession("c");
    workers[2]!.emit("event", {
      type: "queue_update",
      steering: ["parked"],
      followUp: [],
      pending: pendingState(["parked"], [], { paused: true, revision: 2 }),
    });
    for (const id of ids.slice(3)) await runtime.openSession(id);

    await vi.waitFor(() =>
      expect(workers.filter((worker) => worker.stops === 0)).toHaveLength(
        MAX_IDLE_WORKERS + 4,
      ),
    );
    expect(workers[0]!.stops).toBe(0); // busy
    expect(workers[1]!.stops).toBe(0); // awaiting extension input
    expect(workers[2]!.stops).toBe(0); // paused Pending owns worker memory

    workers[0]!.emit("event", { type: "agent_settled" });
    await runtime.extensionUiResponse({
      sessionId: "b",
      id: "question-b",
      confirmed: true,
    });
    await vi.waitFor(() =>
      expect(workers.filter((worker) => worker.stops === 0)).toHaveLength(
        MAX_IDLE_WORKERS + 2,
      ),
    );
    expect(workers[2]!.stops).toBe(0);

    workers[2]!.emit("event", {
      type: "queue_update",
      steering: [],
      followUp: [],
      pending: pendingState([], [], { revision: 3 }),
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
      await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(
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
      const snapshot = await runtime.newSession(TEST_CWD);
      expect(snapshot.active?.sessionId).toBe("new-id");
      expect(worker?.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("tracks a partial new-session header until the worker completes it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-new-session-"));
    workspaceDirectories.push(directory);
    const sessionPath = join(directory, "new-id.jsonl");
    const serializedHeader = JSON.stringify({
      type: "session",
      version: 3,
      id: "new-id",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: TEST_CWD,
    });
    const store = new AttachmentStore();
    attachments.push(store);
    let worker: FakeRpc | undefined;
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.sessionPath = sessionPath;
        worker.start = async () => {
          worker!.starts += 1;
          await writeFile(sessionPath, serializedHeader.slice(0, -1));
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await expect(runtime.newSession(TEST_CWD)).resolves.toMatchObject({
        active: { sessionId: "new-id" },
      });
      const internals = runtime as unknown as {
        slots: Map<
          string,
          {
            projection: { uncommittedBytes: number };
          }
        >;
        reconcileSlot(slot: unknown, force: boolean): Promise<unknown>;
      };
      const slot = internals.slots.get("new-id")!;
      expect(slot.projection.uncommittedBytes).toBeGreaterThan(0);

      const touchedAt = new Date(Date.now() + 10_000);
      await utimes(sessionPath, touchedAt, touchedAt);
      await internals.reconcileSlot(slot, true);
      expect(worker?.stops).toBe(0);

      await appendFile(sessionPath, `${serializedHeader.slice(-1)}\n`);
      await vi.waitFor(() => expect(slot.projection.uncommittedBytes).toBe(0), {
        timeout: 5_000,
      });
      expect(worker?.stops).toBe(0);
      expect((await runtime.snapshot()).active?.projectionConflict).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it("rejects a new Pi worker that reports a path owned by another slot", async () => {
    const existing = record("a", "/tmp");
    existing.path = resolve("/sessions/a.jsonl");
    const store = new AttachmentStore();
    attachments.push(store);
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([existing]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        if (workers.length === 2) {
          worker.sessionId = "new-id";
          worker.sessionPath = existing.path;
        }
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await vi.waitFor(() => expect(workers).toHaveLength(1));

      await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(
        "Pi created a duplicate session path",
      );
      expect(workers[1]?.stops).toBeGreaterThan(0);
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
      const snapshot = await runtime.newSession(TEST_CWD);
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
        worker.sessionPath = join(TEST_CWD, "new-id.jsonl");
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
      const snapshot = await runtime.newSession(TEST_CWD, {
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

    workers[0]!.emit("event", { type: "agent_start" });
    workers[0]!.emit("event", {
      type: "message_end",
      message: { role: "assistant", stopReason: "length" },
    });
    workers[0]!.emit("event", { type: "agent_settled" });
    expect((await runtime.snapshot()).sessionStatuses.a).toEqual({
      runState: "failed",
    });

    await runtime.openSession("b");
    expect((await runtime.snapshot()).sessionStatuses.b).toEqual({
      runState: "failed",
    });
    await runtime.close();
  });

  it("keeps a read-only recovery snapshot and clears stale extension UI after worker exit", async () => {
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
    const emitted: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) =>
      emitted.push(event as Record<string, unknown>),
    );

    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    worker.emit("event", {
      type: "extension_ui_request",
      id: "question-1",
      method: "confirm",
    });
    worker.emit("event", {
      type: "extension_ui_request",
      id: "widget-1",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["one"],
    });
    worker.emit("event", {
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      statusKey: "usage",
      statusText: "37%",
    });
    expect((await runtime.snapshot()).extensionDisplays).toHaveLength(1);
    worker.emit("exit", new Error("worker crashed"));

    const recovered = await runtime.snapshot();
    expect(recovered.active?.transcriptPage.messages).toEqual([
      { role: "user", content: "preview:a", timestamp: 1 },
    ]);
    expect(recovered.runState).toBe("failed");
    expect(recovered.pendingExtensionUiRequests).toEqual([]);
    expect(recovered.extensionDisplays).toEqual([]);
    expect(recovered.extensionStatuses).toEqual({});
    expect(recovered.sessionStatuses.a).toEqual({ runState: "failed" });
    expect(emitted.at(-1)).toMatchObject({
      type: "runtime_error",
      extensionDisplays: [],
      extensionStatuses: {},
    });
    await runtime.close();
  });

  it("keeps legacy pending projections for reconnect and clears them on settlement and worker replacement", async () => {
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

    const longPendingText = "x".repeat(600);
    worker.emit("event", {
      type: "queue_update",
      steering: ["first", longPendingText],
      followUp: ["later"],
    });
    expect((await runtime.snapshot()).pendingQueues).toEqual({
      managementAvailable: false,
      paused: false,
      revision: 1,
      steering: [
        pendingEntry("legacy-steer-0", "first"),
        {
          ...pendingEntry("legacy-steer-1", "x".repeat(512)),
          textLength: 600,
          textTruncated: true,
        },
      ],
      followUp: [pendingEntry("legacy-followUp-0", "later")],
    });

    worker.emit("event", {
      type: "queue_update",
      steering: Array.from({ length: 1_001 }, (_, index) => `steer-${index}`),
      followUp: ["bounded-out"],
    });
    expect((await runtime.snapshot()).pendingQueues).toMatchObject({
      managementAvailable: false,
      revision: 2,
      steering: { length: 1_000 },
      followUp: [],
    });

    worker.emit("event", { type: "agent_settled" });
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).pendingQueues).toEqual({
        managementAvailable: false,
        paused: false,
        revision: 0,
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
      managementAvailable: false,
      paused: false,
      revision: 0,
      steering: [],
      followUp: [],
    });
    await runtime.close();
  });

  it("revision-checks Pending management and fetches exact text only on demand", async () => {
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
    const forwarded: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) =>
      forwarded.push(event as Record<string, unknown>),
    );

    const active = pendingState(["first"], ["later"], { revision: 4 });
    worker.emit("event", {
      type: "queue_update",
      steering: ["first"],
      followUp: ["later"],
      pending: active,
    });
    expect(forwarded.at(-1)).toMatchObject({
      type: "queue_update",
      pendingQueues: { managementAvailable: true, revision: 4 },
    });
    expect(forwarded.at(-1)).not.toHaveProperty("steering");
    expect(forwarded.at(-1)).not.toHaveProperty("followUp");
    expect(forwarded.at(-1)).not.toHaveProperty("pending");
    const paused = pendingState(["first"], ["later"], {
      paused: true,
      revision: 5,
    });
    worker.responseOverrides.set("pause_pending", paused);

    await expect(
      runtime.managePending("a", { action: "pause", expectedRevision: 3 }),
    ).rejects.toMatchObject({ status: 409 });
    const result = await runtime.managePending("a", {
      action: "pause",
      expectedRevision: 4,
    });
    expect(result).toEqual({ managementAvailable: true, ...paused });
    expect(worker.commands.at(-1)).toEqual({
      type: "pause_pending",
      expectedRevision: 4,
    });

    worker.emit("event", {
      type: "queue_update",
      pending: pendingState(["stale"], [], { revision: 4 }),
    });
    expect((await runtime.snapshot()).pendingQueues).toEqual({
      managementAvailable: true,
      ...paused,
    });

    worker.responseOverrides.set(
      "get_pending_message_texts",
      (command: Record<string, unknown>) => ({
        messages: (command.messageIds as string[]).map((id) => ({
          id,
          text: id === "steer-1" ? "first" : "later",
        })),
      }),
    );
    await expect(
      runtime.pendingMessageTexts("a", ["steer-1", "follow-1"]),
    ).resolves.toEqual([
      { id: "steer-1", text: "first" },
      { id: "follow-1", text: "later" },
    ]);
    expect(worker.commands.slice(-2)).toEqual([
      {
        type: "get_pending_message_texts",
        messageIds: ["steer-1"],
        expectedRevision: 5,
      },
      {
        type: "get_pending_message_texts",
        messageIds: ["follow-1"],
        expectedRevision: 5,
      },
    ]);

    const largeText = "x".repeat(3 * 1024 * 1024);
    worker.responseOverrides.set(
      "get_pending_message_texts",
      (command: Record<string, unknown>) => ({
        messages: (command.messageIds as string[]).map((id) => ({
          id,
          text: largeText,
        })),
      }),
    );
    await expect(
      runtime.pendingMessageTexts("a", ["steer-1", "follow-1"]),
    ).rejects.toMatchObject({ status: 413 });
    await runtime.close();
  });

  it("projects text widgets, bounds raw displays, and cancels unknown interactive methods", async () => {
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
    const emitted: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) =>
      emitted.push(event as Record<string, unknown>),
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));

    worker.emit("event", {
      type: "extension_ui_request",
      id: "widget-1",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["one", "two"],
      widgetPlacement: "belowEditor",
      extensionPath: "/extensions/plan.ts",
      body: "must not cross from a native widget",
      apiToken: "must not cross",
    });
    let snapshot = await runtime.snapshot();
    expect(snapshot.extensionDisplays).toEqual([
      {
        id: "setWidget:plan",
        kind: "widget",
        label: "plan",
        source: "/extensions/plan.ts",
        placement: "belowEditor",
        lines: ["one", "two"],
      },
    ]);
    expect(JSON.stringify(snapshot.extensionDisplays)).not.toContain(
      "must not cross",
    );
    expect(snapshot.pendingExtensionUiRequests).toEqual([]);
    const widgetEvent = emitted.findLast(
      (event) =>
        event.type === "extension_ui_request" && event.id === "widget-1",
    );
    expect(widgetEvent).toEqual(
      expect.objectContaining({
        method: "setWidget",
        responseRequired: false,
        extensionDisplays: snapshot.extensionDisplays,
      }),
    );
    expect(widgetEvent).not.toHaveProperty("body");
    expect(widgetEvent).not.toHaveProperty("apiToken");

    worker.emit("event", {
      type: "extension_ui_request",
      id: "widget-key-oversized",
      method: "setWidget",
      widgetKey: "k".repeat(MAX_EXTENSION_KEY_CHARS + 1),
      widgetLines: ["must be rejected"],
    });
    snapshot = await runtime.snapshot();
    expect(snapshot.extensionDisplays).toEqual([
      expect.objectContaining({ id: "setWidget:plan", kind: "widget" }),
    ]);
    expect(emitted.at(-1)).toMatchObject({
      extensionDisplays: snapshot.extensionDisplays,
    });
    expect(emitted.at(-1)).not.toHaveProperty("widgetKey");
    expect(emitted.at(-1)).not.toHaveProperty("widgetLines");

    worker.emit("event", {
      type: "extension_ui_request",
      id: "widget-oversized",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["x".repeat(140 * 1024)],
    });
    snapshot = await runtime.snapshot();
    expect(snapshot.extensionDisplays).toEqual([
      expect.objectContaining({
        id: "setWidget:plan",
        kind: "raw",
        payload: expect.objectContaining({ truncated: true }),
      }),
    ]);

    worker.emit("event", {
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      statusKey: "usage",
      statusText: "37%",
      responseRequired: false,
    });
    snapshot = await runtime.snapshot();
    expect(snapshot.extensionDisplays).toHaveLength(1);
    expect(snapshot.extensionStatuses).toEqual({ usage: "37%" });
    expect(emitted.at(-1)).toMatchObject({
      type: "extension_ui_request",
      method: "setStatus",
      extensionStatuses: { usage: "37%" },
    });
    expect(emitted.at(-1)).not.toHaveProperty("extensionDisplays");
    expect(emitted.at(-1)).not.toHaveProperty("statusText");

    worker.emit("event", {
      type: "extension_ui_request",
      id: "status-oversized",
      method: "setStatus",
      statusKey: "usage",
      statusText: "x".repeat(MAX_EXTENSION_STATUS_CHARS + 200),
    });
    expect((await runtime.snapshot()).extensionStatuses?.usage).toBe(
      `${"x".repeat(MAX_EXTENSION_STATUS_CHARS - 1)}…`,
    );

    worker.emit("event", {
      type: "extension_ui_request",
      id: "status-multibyte",
      method: "setStatus",
      statusKey: "usage",
      statusText: "🧭".repeat(MAX_EXTENSION_STATUS_CHARS + 1),
    });
    const multibyteStatus = (await runtime.snapshot()).extensionStatuses?.usage;
    expect(multibyteStatus).toBeDefined();
    expect(Array.from(multibyteStatus!).length).toBeLessThanOrEqual(
      MAX_EXTENSION_STATUS_CHARS,
    );
    expect(multibyteStatus).toMatch(/^(?:🧭)*…$/u);

    worker.emit("event", {
      type: "extension_ui_request",
      id: "status-clear",
      method: "setStatus",
      statusKey: "usage",
    });
    expect((await runtime.snapshot()).extensionStatuses).toEqual({});

    for (let index = 0; index < 22; index += 1) {
      worker.emit("event", {
        type: "extension_ui_request",
        id: `status-${index}`,
        method: "setStatus",
        statusKey: `status-${index}`,
        statusText: String(index),
      });
    }
    snapshot = await runtime.snapshot();
    expect(Object.keys(snapshot.extensionStatuses ?? {})).toHaveLength(20);
    expect(snapshot.extensionStatuses).not.toHaveProperty("status-0");
    expect(snapshot.extensionStatuses).not.toHaveProperty("status-1");
    expect(snapshot.extensionStatuses).toMatchObject({ "status-21": "21" });

    worker.emit("event", {
      type: "extension_ui_request",
      id: "panel-1",
      method: "showPanel",
      responseRequired: false,
      extensionPath: "/extensions/build.ts",
      body: "x".repeat(140 * 1024),
      apiToken: "must not cross",
    });
    snapshot = await runtime.snapshot();
    expect(snapshot.extensionDisplays?.at(-1)).toEqual(
      expect.objectContaining({
        id: "showPanel:panel-1",
        kind: "raw",
        label: "panel-1",
        source: "/extensions/build.ts",
        method: "showPanel",
        payload: expect.objectContaining({ truncated: true }),
      }),
    );
    expect(JSON.stringify(snapshot.extensionDisplays)).not.toContain(
      "must not cross",
    );

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

  it("rejects an open whose catalog lookup outlives runtime close", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const base = catalog([record("a", "/project")]);
    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>((resolveCatalog) => {
      releaseCatalog = resolveCatalog;
    });
    let lookupStarted = false;
    let previewLoads = 0;
    const runtime = new RuntimeController(
      {
        ...base,
        get: async (id) => {
          lookupStarted = true;
          await catalogGate;
          return base.get(id);
        },
      },
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      async (session) => {
        previewLoads += 1;
        return preview(session);
      },
    );

    const opening = runtime.openSession("a");
    await vi.waitFor(() => expect(lookupStarted).toBe(true));
    await expect(runtime.close()).resolves.toBeUndefined();
    releaseCatalog();

    await expect(opening).rejects.toThrow(/closing/);
    expect(previewLoads).toBe(0);
    expect(
      (runtime as unknown as { slots: Map<string, unknown> }).slots.size,
    ).toBe(0);
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
    const creating = runtime.newSession(TEST_CWD);
    await vi.waitFor(() => expect(worker?.starts).toBe(1));
    const closing = runtime.close();
    await vi.waitFor(() => expect(worker.stops).toBe(1));
    await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(/closing/);
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
    const creating = runtime.newSession(TEST_CWD);
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
    await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(
      /startup failed/,
    );
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

    const created = await runtime.newSession(TEST_CWD);
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
      expect.objectContaining({ id: "a", path: resolve("/sessions/a.jsonl") }),
    );
    expect(source.refresh).not.toHaveBeenCalled();
    expect(source.invalidate).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("does not delete a catalog identity reserved by a provisional new session", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      undefined,
      preview,
      15_000,
      undefined,
      remove,
    );
    const provisionalSlots = (
      runtime as unknown as {
        provisionalSlots: Map<
          string,
          {
            slot: { id: string; sessionPath: string | null };
            completion: Promise<void>;
          }
        >;
      }
    ).provisionalSlots;
    provisionalSlots.set("pending-test", {
      slot: { id: "a", sessionPath: null },
      completion: new Promise(() => undefined),
    });
    try {
      await expect(runtime.deleteSession("a")).rejects.toMatchObject({
        status: 409,
        message: "Wait for the session to finish opening before deleting it",
      });
      expect(remove).not.toHaveBeenCalled();
    } finally {
      provisionalSlots.delete("pending-test");
      await runtime.close();
    }
  });

  it("clears individually hidden sessions and every session in hidden folders after reserving all identities", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const source = catalog([
      record("a", "/loose"),
      record("b", "/folder"),
      record("c", "/folder"),
      record("ordinary", "/ordinary"),
    ]);
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
      runtime.clearHiddenSessions(["a", "b", "c"], ["a"], [HIDDEN_FOLDER_CWD]),
    ).resolves.toEqual({
      deleted: [
        { sessionId: "a", disposition: "trashed" },
        { sessionId: "b", disposition: "trashed" },
        { sessionId: "c", disposition: "trashed" },
      ],
    });
    expect(source.refresh).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledTimes(3);
    expect(remove).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "ordinary" }),
    );
    await runtime.close();
  });

  it("preflights every Hidden file before moving the first one", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const remove = vi.fn(async () => "trashed" as const);
    const validate = vi.fn(async (session: SessionRecord) => {
      if (session.id === "b")
        throw Object.assign(new Error("session b changed"), { status: 409 });
    });
    const runtime = new RuntimeController(
      catalog([record("a", "/folder"), record("b", "/folder")]),
      store,
      undefined,
      preview,
      15_000,
      undefined,
      remove,
      undefined,
      validate,
    );

    await expect(
      runtime.clearHiddenSessions(["a", "b"], [], [HIDDEN_FOLDER_CWD]),
    ).rejects.toMatchObject({ status: 409, message: "session b changed" });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(remove).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("rejects a Hidden clear if its reviewed session snapshot changed", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/loose"), record("b", "/folder")]),
      store,
      undefined,
      preview,
      15_000,
      undefined,
      remove,
    );

    await expect(
      runtime.clearHiddenSessions(["a"], ["a"], [HIDDEN_FOLDER_CWD]),
    ).rejects.toMatchObject({
      status: 409,
      message: "Hidden changed; review it before clearing",
    });
    expect(remove).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("rejects a Hidden clear before moving any session when one is selected", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/loose"), record("b", "/folder")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
      15_000,
      undefined,
      remove,
    );
    await runtime.openSession("a");

    await expect(
      runtime.clearHiddenSessions(["a", "b"], ["a"], [HIDDEN_FOLDER_CWD]),
    ).rejects.toMatchObject({
      status: 409,
      message: "Switch to another session before clearing Hidden",
    });
    expect(remove).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("rejects a Hidden clear before moving any session when Pending is paused", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const workers = new Map<string, FakeRpc>();
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/hidden"), record("ordinary", "/ordinary")]),
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
    const worker = workers.get("a")!;
    await vi.waitFor(() => expect(worker.starts).toBe(1));
    worker.emit("event", {
      type: "queue_update",
      steering: [],
      followUp: [],
      pending: pendingState([], [], { paused: true, revision: 1 }),
    });
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).pendingQueues?.paused).toBe(true),
    );
    await runtime.openSession("ordinary");

    await expect(
      runtime.clearHiddenSessions(["a"], ["a"], []),
    ).rejects.toMatchObject({ status: 409 });
    expect(remove).not.toHaveBeenCalled();
    expect(worker.stops).toBe(0);
    await runtime.close();
  });

  it("refuses an ambiguous catalog identity before touching either file", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const first = record("a", "/tmp");
    const second = {
      ...record("a", "/other"),
      path: resolve("/sessions/copied-a.jsonl"),
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

  it("refuses to delete an unselected session while Pending is paused", async () => {
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
    const worker = workers.get("a")!;
    await vi.waitFor(() => expect(worker.starts).toBe(1));
    worker.emit("event", {
      type: "queue_update",
      steering: [],
      followUp: [],
      pending: pendingState([], [], { paused: true, revision: 1 }),
    });
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).pendingQueues?.paused).toBe(true),
    );
    await runtime.openSession("b");

    await expect(runtime.deleteSession("a")).rejects.toMatchObject({
      status: 409,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(worker.stops).toBe(0);
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

  it("accepts the full image attachment limit without counting RPC image parts twice", async () => {
    const store = new AttachmentStore();
    attachments.push(store);
    const uploaded = await store.addMany(
      Array.from({ length: 8 }, (_, index) =>
        upload(`shot-${index}.png`, "image/png"),
      ),
    );
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
      message: "use these images",
      attachmentIds: uploaded.map((item) => item.id),
    });

    const promptCommand = worker.commands.find(
      (command) => command.type === "prompt",
    );
    expect(promptCommand?.images).toHaveLength(8);
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
    const referenced = JSON.parse(
      String(promptCommand?.message ?? "").split("\n- ")[1]!,
    ) as string;
    expect(referenced).toContain("notes.txt");
    await expect(access(referenced)).resolves.toBeUndefined();
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
    await expect(runtime.newSession(TEST_CWD)).rejects.toMatchObject({
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
