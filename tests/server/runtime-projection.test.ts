import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { appendFile, access, mkdtemp, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcOutcomeUnknownError, type PiRpcOptions, type PiRpcProcess } from "../../server/pi-rpc.js";
import { MAX_IDLE_WORKERS, PARTIAL_PERSISTENCE_TIMEOUT_MS, RuntimeController } from "../../server/runtime.js";
import { TRANSCRIPT_PAGE_MAX_BYTES, TRANSIENT_OVERLAY_MAX_BYTES } from "../../server/session-projection.js";
import type { SessionCatalogLike, SessionRecord } from "../../server/session-catalog.js";

const directories: string[] = [];
const stores: AttachmentStore[] = [];

class ProjectionRpc extends EventEmitter {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly sessionPath: string;
  stops = 0;
  onStop: (() => void) | null = null;
  onStart: (() => Promise<void>) | null = null;
  startupEntries: unknown[] = [];
  startupLeafId: string | null | undefined;
  stateThinkingLevel = "off";
  constructor(readonly options: PiRpcOptions, private readonly sequence: string[]) {
    super();
    const marker = options.args?.indexOf("--session") ?? -1;
    this.sessionPath = resolve(options.args![marker + 1]!);
  }
  async start() { this.sequence.push("start"); await this.onStart?.(); }
  async stop() { this.stops += 1; this.sequence.push("stop"); this.onStop?.(); }
  async request<T>(command: Record<string, unknown>): Promise<T> {
    this.commands.push(command);
    this.sequence.push(String(command.type));
    const value = command.type === "get_state"
      ? { sessionId: "session-a", sessionFile: this.sessionPath, model: null, thinkingLevel: this.stateThinkingLevel, isStreaming: false, isCompacting: false }
      : command.type === "get_entries"
        ? { entries: this.startupEntries, leafId: this.startupLeafId === undefined ? (command.since ?? null) : this.startupLeafId }
      : command.type === "get_available_models" ? { models: [] }
      : command.type === "get_commands" ? { commands: [] }
      : {};
    return value as T;
  }
  sendExtensionUiResponse(response: Record<string, unknown>) { this.commands.push({ type: "extension_ui_response", ...response }); }
}

class NewSessionRpc extends EventEmitter {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly entries: Array<Record<string, unknown>>;
  stops = 0;
  sessionName: string | undefined;
  emitEventsBeforeWrite = true;
  materializationCuts: number[] = [];
  onMaterializationCut: ((lineCount: number) => Promise<void>) | null = null;
  reusePromptTimestamps = false;
  private promptCount = 0;
  private materialized = false;
  private promptMessages: { user: Record<string, unknown>; assistant: Record<string, unknown> } | null = null;

  constructor(
    readonly options: PiRpcOptions,
    readonly sessionPath: string,
    readonly sessionId = "new-session",
  ) {
    super();
    this.entries = [
      {
        type: "model_change", id: "model-1", parentId: null, timestamp: "2026-08-01T00:00:01.000Z",
        provider: "test", modelId: "model",
      },
      {
        type: "thinking_level_change", id: "thinking-1", parentId: "model-1", timestamp: "2026-08-01T00:00:02.000Z",
        thinkingLevel: "medium",
      },
    ];
  }

  async start() {}
  async stop() { this.stops += 1; }
  async request<T>(command: Record<string, unknown>): Promise<T> {
    this.commands.push(command);
    if (command.type === "get_state") {
      return {
        sessionId: this.sessionId,
        sessionFile: this.sessionPath,
        sessionName: this.sessionName,
        model: { provider: "test", id: "model" },
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
      } as T;
    }
    if (command.type === "get_entries") {
      const since = typeof command.since === "string" ? this.entries.findIndex((entry) => entry.id === command.since) : -1;
      const entries = since >= 0 ? this.entries.slice(since + 1) : this.entries;
      return { entries: structuredClone(entries), leafId: this.entries.at(-1)?.id ?? null } as T;
    }
    if (command.type === "set_session_name") {
      this.sessionName = String(command.name ?? "");
      this.entries.push({
        type: "session_info", id: "name-1", parentId: this.entries.at(-1)?.id ?? null,
        timestamp: "2026-08-01T00:00:03.000Z", name: this.sessionName,
      });
      return {} as T;
    }
    if (command.type === "prompt") {
      const index = ++this.promptCount;
      const timestampIndex = this.reusePromptTimestamps ? 1 : index;
      const user = { role: "user", content: String(command.message ?? ""), timestamp: 2 + timestampIndex * 2 };
      const assistant = {
        role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 3 + timestampIndex * 2, stopReason: "stop",
      };
      this.promptMessages = { user, assistant };
      const promptEntries = [
        {
          type: "message", id: `user-${index}`, parentId: this.entries.at(-1)?.id ?? null,
          timestamp: `2026-08-01T00:00:${String(2 + index * 2).padStart(2, "0")}.000Z`, message: user,
        },
        {
          type: "message", id: `assistant-${index}`, parentId: `user-${index}`,
          timestamp: `2026-08-01T00:00:${String(3 + index * 2).padStart(2, "0")}.000Z`, message: assistant,
        },
      ];
      this.entries.push(...promptEntries);
      if (this.emitEventsBeforeWrite) this.emitPromptEvents();
      if (this.materialized) {
        await appendFile(this.sessionPath, `${promptEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      } else {
        const header = {
          type: "session", version: 3, id: this.sessionId, timestamp: "2026-08-01T00:00:00.000Z", cwd: this.options.cwd,
        };
        const lines = [header, ...this.entries].map((entry) => JSON.stringify(entry));
        let written = 0;
        for (const cut of this.materializationCuts) {
          const end = Math.min(Math.max(cut, written), lines.length);
          if (end === written) continue;
          const chunk = `${lines.slice(written, end).join("\n")}\n`;
          if (written === 0) await writeFile(this.sessionPath, chunk);
          else await appendFile(this.sessionPath, chunk);
          written = end;
          await this.onMaterializationCut?.(written);
        }
        const remainder = `${lines.slice(written).join("\n")}\n`;
        if (written === 0) await writeFile(this.sessionPath, remainder);
        else if (written < lines.length) await appendFile(this.sessionPath, remainder);
        this.materialized = true;
      }
      return {} as T;
    }
    if (command.type === "get_available_models") return { models: [] } as T;
    if (command.type === "get_commands") return { commands: [] } as T;
    return {} as T;
  }
  emitPromptEvents() {
    if (!this.promptMessages) return;
    const messages = this.promptMessages;
    this.promptMessages = null;
    this.emit("event", { type: "agent_start" });
    this.emit("event", { type: "message_end", message: messages.user });
    this.emit("event", { type: "message_end", message: messages.assistant });
  }
  async sendExtensionUiResponse(_response: Record<string, unknown>) {}
}

function emptyCatalog(): SessionCatalogLike {
  return {
    refresh: async () => [], get: async () => undefined,
    list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
    listByIds: async () => [], listByCwds: async () => [], invalidate: () => undefined,
  };
}

async function setupNewSession(configure?: (worker: NewSessionRpc) => void) {
  const directory = await mkdtemp(join(tmpdir(), "inspire-runtime-new-session-"));
  directories.push(directory);
  const path = join(directory, "future-session.jsonl");
  const attachments = new AttachmentStore(join(directory, "uploads"));
  stores.push(attachments);
  let worker!: NewSessionRpc;
  const runtime = new RuntimeController(emptyCatalog(), attachments, (options) => {
    worker = new NewSessionRpc(options, path);
    configure?.(worker);
    return worker as unknown as PiRpcProcess;
  });
  return { directory, path, runtime, attachments, get worker() { return worker; } };
}

async function setup(
  extraEntries: unknown[] = [],
  configure?: (worker: ProjectionRpc) => void,
  includeUser = true,
  trailingBytes = "",
  expectWorker = true,
) {
  const directory = await mkdtemp(join(tmpdir(), "inspire-runtime-projection-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  const header = { type: "session", version: 3, id: "session-a", timestamp: "2026-08-01T00:00:00.000Z", cwd: directory };
  const user = {
    type: "message", id: "u1", parentId: null, timestamp: "2026-08-01T00:00:01.000Z",
    message: { role: "user", content: "original", timestamp: 1 },
  };
  await writeFile(path, `${[header, ...(includeUser ? [user] : []), ...extraEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n${trailingBytes}`);
  const record: SessionRecord = {
    id: "session-a", cwd: directory, path, created: new Date(), modified: new Date(), messageCount: includeUser ? 1 : 0,
    firstMessage: "original", searchText: "original",
  };
  const catalog: SessionCatalogLike = {
    refresh: async () => [record], get: async (id) => id === record.id ? record : undefined,
    list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
    listByIds: async () => [], listByCwds: async () => [], invalidate: () => undefined,
  };
  const attachments = new AttachmentStore(join(directory, "uploads"));
  stores.push(attachments);
  const workers: ProjectionRpc[] = [];
  const sequence: string[] = [];
  const runtime = new RuntimeController(catalog, attachments, (options) => {
    const worker = new ProjectionRpc(options, sequence);
    configure?.(worker);
    workers.push(worker);
    return worker as unknown as PiRpcProcess;
  });
  await runtime.openSession("session-a");
  if (expectWorker) await vi.waitFor(() => expect(workers).toHaveLength(1));
  return { runtime, workers, sequence, path };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RuntimeController new-session materialization", () => {
  it("returns an empty session before its JSONL exists and accepts the exact first Pi flush", async () => {
    const fixture = await setupNewSession();
    try {
      const created = await fixture.runtime.newSession(fixture.directory);
      expect(created.active).toMatchObject({
        sessionId: "new-session",
        sessionFile: fixture.path,
        messages: [],
        projectionHealth: { status: "ok" },
      });
      await expect(access(fixture.path)).rejects.toMatchObject({ code: "ENOENT" });

      await fixture.runtime.rename("new-session", "Named before first prompt");
      await expect(access(fixture.path)).rejects.toMatchObject({ code: "ENOENT" });

      await fixture.runtime.prompt({ sessionId: "new-session", message: "first prompt", attachmentIds: [], projectFiles: [] });
      const snapshot = await fixture.runtime.snapshot();
      expect(snapshot.active?.messages).toEqual([
        expect.objectContaining({ role: "user", content: "first prompt" }),
        expect.objectContaining({ role: "assistant" }),
      ]);
      expect(snapshot.active?.projectionHealth).toEqual({ status: "ok" });
      expect(snapshot.active?.projectionConflict).toBeNull();
      expect(fixture.worker.stops).toBe(0);
    } finally {
      await fixture.runtime.close();
    }
  });

  it("accepts header-only and complete-line prefixes from one first flush", async () => {
    let runtime!: RuntimeController;
    const observations: Array<{ lineCount: number; messages: number; conflict: unknown }> = [];
    const fixture = await setupNewSession((worker) => {
      worker.emitEventsBeforeWrite = false;
      worker.materializationCuts = [1, 3];
      worker.onMaterializationCut = async (lineCount) => {
        const snapshot = await runtime.snapshot();
        observations.push({
          lineCount,
          messages: snapshot.active?.messages.length ?? -1,
          conflict: snapshot.active?.projectionConflict,
        });
      };
    });
    runtime = fixture.runtime;
    try {
      await runtime.newSession(fixture.directory);
      await runtime.prompt({ sessionId: "new-session", message: "first prompt", attachmentIds: [], projectFiles: [] });
      expect(observations).toEqual([
        { lineCount: 1, messages: 0, conflict: null },
        { lineCount: 3, messages: 0, conflict: null },
      ]);
      fixture.worker.emitPromptEvents();
      const snapshot = await runtime.snapshot();
      expect(snapshot.active?.messages).toHaveLength(2);
      expect(snapshot.active?.projectionConflict).toBeNull();
      expect(fixture.worker.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("accepts first materialization before its message events reach the host", async () => {
    const fixture = await setupNewSession((worker) => { worker.emitEventsBeforeWrite = false; });
    try {
      await fixture.runtime.newSession(fixture.directory);
      await fixture.runtime.prompt({ sessionId: "new-session", message: "first prompt", attachmentIds: [], projectFiles: [] });
      expect((await fixture.runtime.snapshot()).active?.projectionConflict).toBeNull();

      fixture.worker.emitPromptEvents();
      fixture.worker.emitEventsBeforeWrite = true;
      fixture.worker.reusePromptTimestamps = true;
      await fixture.runtime.prompt({ sessionId: "new-session", message: "second prompt", attachmentIds: [], projectFiles: [] });
      const snapshot = await fixture.runtime.snapshot();
      expect(snapshot.active?.projectionConflict).toBeNull();
      expect(snapshot.active?.messages).toHaveLength(4);
    } finally {
      await fixture.runtime.close();
    }
  });

  it("bounds idle unmaterialized workers with the existing LRU", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-runtime-pending-lru-"));
    directories.push(directory);
    const attachments = new AttachmentStore(join(directory, "uploads"));
    stores.push(attachments);
    const workers: NewSessionRpc[] = [];
    const runtime = new RuntimeController(emptyCatalog(), attachments, (options) => {
      const index = workers.length + 1;
      const worker = new NewSessionRpc(options, join(directory, `future-${index}.jsonl`), `new-session-${index}`);
      workers.push(worker);
      return worker as unknown as PiRpcProcess;
    });

    try {
      for (let index = 0; index < MAX_IDLE_WORKERS + 2; index += 1) await runtime.newSession(directory);
      await vi.waitFor(() => expect(workers.filter((worker) => worker.stops > 0)).toHaveLength(1));
      expect(workers.at(-1)?.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("rejects a mismatched file that appears between worker capture and projection open", async () => {
    const fixture = await setupNewSession((worker) => {
      const request = worker.request.bind(worker);
      worker.request = async <T,>(command: Record<string, unknown>) => {
        const result = await request<T>(command);
        if (command.type === "get_entries") {
          const header = {
            type: "session", version: 3, id: worker.sessionId, timestamp: "2026-08-01T00:00:00.000Z",
            cwd: join(worker.options.cwd, "other-project"),
          };
          await writeFile(worker.sessionPath, `${[header, ...worker.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
        }
        return result;
      };
    });

    try {
      await expect(fixture.runtime.newSession(fixture.directory)).rejects.toMatchObject({ status: 409 });
      expect(fixture.worker.stops).toBe(1);
    } finally {
      await fixture.runtime.close();
    }
  });

  it("fails closed when the first file differs from the creating worker", async () => {
    const fixture = await setupNewSession((worker) => {
      const request = worker.request.bind(worker);
      worker.request = async <T,>(command: Record<string, unknown>) => {
        if (command.type !== "prompt") return request<T>(command);
        const result = await request<T>(command);
        const lines = (await readFile(worker.sessionPath, "utf8")).trim().split("\n");
        const injected = {
          type: "custom", customType: "external", data: {}, id: "external-1", parentId: "thinking-1",
          timestamp: "2026-08-01T00:00:03.500Z",
        };
        lines.splice(3, 0, JSON.stringify(injected));
        await writeFile(worker.sessionPath, `${lines.join("\n")}\n`);
        return result;
      };
    });

    try {
      const image = await fixture.attachments.add({
        originalname: "first.png", mimetype: "image/png", size: 3, buffer: Buffer.from("png"),
      } as Express.Multer.File);
      await fixture.runtime.newSession(fixture.directory);
      await expect(fixture.runtime.prompt({
        sessionId: "new-session", message: "first prompt", attachmentIds: [image.id], projectFiles: [],
      })).rejects.toMatchObject({ status: 409 });
      await expect(fixture.attachments.resolveForPrompt([image.id])).rejects.toThrow(/expired/);
      expect(fixture.worker.stops).toBe(1);
      expect((await fixture.runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await fixture.runtime.close();
    }
  });
});

describe("RuntimeController projection ownership gate", () => {
  const startupThinking = (parentId: string | null, thinkingLevel = "off", id = "startup1") => ({
    type: "thinking_level_change", id, parentId, timestamp: "2026-08-01T00:00:02.000Z", thinkingLevel,
  });

  it("accepts one exact state-equivalent missing-thinking delta at the startup boundary", async () => {
    const entry = startupThinking("u1");
    const { runtime, workers } = await setup([], (worker) => {
      worker.startupEntries = [entry];
      worker.startupLeafId = entry.id;
      worker.onStart = async () => { await appendFile(worker.sessionPath, `${JSON.stringify(entry)}\n`); };
    });
    try {
      await vi.waitFor(async () => expect((await runtime.snapshot()).active?.thinkingLevel).toBe("off"));
      await vi.waitFor(() => expect(workers[0]!.commands.some((command) => command.type === "get_commands")).toBe(true));
      expect(workers[0]!.commands).toContainEqual({ type: "get_entries", since: "u1" });
      expect(workers[0]!.stops).toBe(0);
      expect((await runtime.branchTree("session-a")).durableLeafId).toBe(entry.id);
    } finally {
      await runtime.close();
    }
  });

  it("accepts the same bounded state-equivalent delta from a trusted empty baseline", async () => {
    const entry = startupThinking(null);
    const { runtime, workers } = await setup([], (worker) => {
      worker.startupEntries = [entry];
      worker.startupLeafId = entry.id;
      worker.onStart = async () => { await appendFile(worker.sessionPath, `${JSON.stringify(entry)}\n`); };
    }, false);
    try {
      await vi.waitFor(async () => {
        await runtime.snapshot();
        expect(workers[0]!.commands.some((command) => command.type === "get_commands")).toBe(true);
      });
      expect(workers[0]!.commands).toContainEqual({ type: "get_entries" });
      expect(workers[0]!.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("accepts exact custom extension state written by the starting worker", async () => {
    const entry = {
      type: "custom", customType: "goal-state", data: { goal: { id: "goal-1", status: "active", tokensUsed: 1 } },
      id: "startup-custom", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z",
    };
    const { runtime, workers } = await setup([], (worker) => {
      worker.startupEntries = [entry];
      worker.startupLeafId = entry.id;
      worker.onStart = async () => { await appendFile(worker.sessionPath, `${JSON.stringify(entry)}\n`); };
    });
    try {
      await vi.waitFor(async () => {
        await runtime.snapshot();
        expect(workers[0]!.commands.some((command) => command.type === "get_commands")).toBe(true);
      });
      expect(workers[0]!.stops).toBe(0);
      expect((await runtime.branchTree("session-a")).durableLeafId).toBe(entry.id);
    } finally {
      await runtime.close();
    }
  });

  it("rejects an otherwise exact state-equivalent entry injected by the process factory before rpc.start", async () => {
    const entry = startupThinking("u1");
    const { runtime, workers, sequence } = await setup([], (worker) => {
      worker.startupEntries = [entry];
      worker.startupLeafId = entry.id;
      appendFileSync(worker.sessionPath, `${JSON.stringify(entry)}\n`);
    });
    try {
      await vi.waitFor(() => expect(workers[0]!.stops).toBe(1));
      expect(sequence).not.toContain("start");
      expect(workers[0]!.commands).toEqual([]);
      expect((await runtime.snapshot()).runState).toBe("failed");
    } finally {
      await runtime.close();
    }
  });

  it.each([
    {
      name: "wrong level",
      prepare: (worker: ProjectionRpc) => {
        const entry = startupThinking("u1", "high");
        worker.startupEntries = [entry];
        worker.startupLeafId = entry.id;
        worker.stateThinkingLevel = "off";
        worker.onStart = async () => { await appendFile(worker.sessionPath, `${JSON.stringify(entry)}\n`); };
      },
    },
    {
      name: "mixed external append",
      prepare: (worker: ProjectionRpc) => {
        const own = startupThinking("u1");
        const external = {
          type: "message", id: "external", parentId: own.id, timestamp: "2026-08-01T00:00:03.000Z",
          message: { role: "assistant", content: "external", timestamp: 3 },
        };
        worker.startupEntries = [own, external];
        worker.startupLeafId = external.id;
        worker.onStart = async () => { await appendFile(worker.sessionPath, `${JSON.stringify(own)}\n${JSON.stringify(external)}\n`); };
      },
    },
    {
      name: "bad parent",
      prepare: (worker: ProjectionRpc) => {
        const entry = startupThinking("not-u1");
        worker.startupEntries = [entry];
        worker.startupLeafId = entry.id;
        worker.onStart = async () => { await appendFile(worker.sessionPath, `${JSON.stringify(entry)}\n`); };
      },
    },
    {
      name: "rewrite",
      prepare: (worker: ProjectionRpc) => {
        const entry = startupThinking("u1");
        worker.startupEntries = [entry];
        worker.startupLeafId = entry.id;
        worker.onStart = async () => {
          const header = { type: "session", version: 3, id: "session-a", timestamp: "2026-08-01T00:00:00.000Z", cwd: worker.options.cwd };
          const changed = {
            type: "message", id: "u1", parentId: null, timestamp: "2026-08-01T00:00:01.000Z",
            message: { role: "user", content: "rewritten", timestamp: 1 },
          };
          await writeFile(worker.sessionPath, `${[header, changed, entry].map((value) => JSON.stringify(value)).join("\n")}\n`);
        };
      },
    },
  ])("fails closed for a $name during startup attestation", async ({ prepare }) => {
    const { runtime, workers } = await setup([], prepare);
    try {
      await vi.waitFor(() => expect(workers[0]!.stops).toBe(1));
      expect((await runtime.snapshot()).runState).toBe("failed");
      expect(workers).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("keeps a greater-than-10-MiB active history bounded without get_messages", async () => {
    const extra: unknown[] = [];
    let parent = "u1";
    for (let index = 0; index < 24; index += 1) {
      const id = `large-${index}`;
      extra.push({
        type: "message", id, parentId: parent, timestamp: new Date(index + 2).toISOString(),
        message: { role: index % 2 ? "assistant" : "user", content: "x".repeat(480_000), timestamp: index + 2 },
      });
      parent = id;
    }
    const { runtime, workers } = await setup(extra);
    try {
      const snapshot = await runtime.snapshot();
      expect(snapshot.active?.transcriptPage.messages.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(snapshot.active?.transcriptPage))).toBeLessThanOrEqual(TRANSCRIPT_PAGE_MAX_BYTES);
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(3 * TRANSCRIPT_PAGE_MAX_BYTES);
      expect(workers.flatMap((worker) => worker.commands).some((command) => command.type === "get_messages")).toBe(false);
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it("stops an idle stale child before the sole replacement receives a prompt", async () => {
    const { runtime, workers, sequence, path } = await setup();
    try {
      const external = {
        type: "message", id: "external", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z",
        message: { role: "assistant", content: "terminal", timestamp: 2 },
      };
      await appendFile(path, `${JSON.stringify(external)}\n`);
      await runtime.prompt({ sessionId: "session-a", message: "continue" });
      expect(workers).toHaveLength(2);
      expect(workers[0]!.stops).toBe(1);
      expect(workers[0]!.commands.some((command) => command.type === "prompt")).toBe(false);
      expect(workers[1]!.commands.filter((command) => command.type === "prompt")).toHaveLength(1);
      expect(sequence.indexOf("stop")).toBeLessThan(sequence.lastIndexOf("prompt"));
      expect(workers.flatMap((worker) => worker.commands).some((command) => command.type === "get_messages")).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("serializes concurrent persistence operations through one freshness replacement", async () => {
    const { runtime, workers, path } = await setup();
    try {
      await appendFile(path, `${JSON.stringify({
        type: "message", id: "external", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z",
        message: { role: "assistant", content: "terminal", timestamp: 2 },
      })}\n`);
      await Promise.all([
        runtime.rename("session-a", "first"),
        runtime.setThinkingLevel("session-a", "high"),
      ]);
      expect(workers).toHaveLength(2);
      expect(workers[0]!.stops).toBe(1);
      expect(workers[1]!.commands.filter((command) => command.type === "set_session_name")).toHaveLength(1);
      expect(workers[1]!.commands.filter((command) => command.type === "set_thinking_level")).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("refreshes stale writers for model and compact control families", async () => {
    const { runtime, workers, path } = await setup();
    try {
      await appendFile(path, `${JSON.stringify({
        type: "model_change", id: "external-model", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z",
        provider: "terminal", modelId: "model",
      })}\n`);
      await runtime.setModel("session-a", "test", "fresh-model");
      expect(workers).toHaveLength(2);
      expect(workers[0]!.commands.some((command) => command.type === "set_model")).toBe(false);
      expect(workers[1]!.commands.some((command) => command.type === "set_model")).toBe(true);

      await appendFile(path, `${JSON.stringify({
        type: "thinking_level_change", id: "external-thinking", parentId: "external-model", timestamp: "2026-08-01T00:00:03.000Z",
        thinkingLevel: "high",
      })}\n`);
      await runtime.prompt({ sessionId: "session-a", message: "/compact" });
      expect(workers).toHaveLength(3);
      expect(workers[1]!.commands.some((command) => command.type === "compact")).toBe(false);
      expect(workers[2]!.commands.some((command) => command.type === "compact")).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("conflicts rather than answering a stale extension-blocked writer", async () => {
    const { runtime, workers, path } = await setup();
    try {
      workers[0]!.emit("event", {
        type: "extension_ui_request", id: "question", method: "confirm", title: "Proceed?",
      });
      await appendFile(path, `${JSON.stringify({
        type: "message", id: "external", parentId: "u1", timestamp: "2026-08-01T00:00:03.000Z",
        message: { role: "assistant", content: "terminal", timestamp: 3 },
      })}\n`);
      await expect(runtime.extensionUiResponse({ sessionId: "session-a", id: "question", confirmed: true })).rejects.toThrow(/changed on disk/);
      expect(workers[0]!.commands.some((command) => command.type === "extension_ui_response")).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("checks each queued projection revision independently when earlier provenance verification waits", async () => {
    const { runtime, workers, path } = await setup();
    let release: (() => void) | undefined;
    try {
      const worker = workers[0]!;
      const original = worker.request.bind(worker);
      let compactStarted!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { compactStarted = resolve; });
      const compactionResult = {
        summary: "owned summary", firstKeptEntryId: "u1", tokensBefore: 100,
      };
      worker.request = async <T,>(command: Record<string, unknown>) => {
        if (command.type !== "compact") return original<T>(command);
        await appendFile(path, `${JSON.stringify({
          type: "compaction", id: "owned-compaction", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z",
          ...compactionResult,
        })}\n`);
        compactStarted();
        await gate;
        return compactionResult as T;
      };
      const compacting = runtime.prompt({ sessionId: "session-a", message: "/compact" });
      const rejected = expect(compacting).rejects.toThrow(/abort to recover/);
      await started;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      await appendFile(path, `${JSON.stringify({
        type: "message", id: "external-after", parentId: "owned-compaction", timestamp: "2026-08-01T00:00:03.000Z",
        message: { role: "assistant", content: "external revision", timestamp: 3 },
      })}\n`);
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      release!();
      await rejected;
      expect((await runtime.snapshot()).runState).toBe("conflict");
    } finally {
      release?.();
      await runtime.close();
    }
  });

  it("rejects same-type and mixed appends unless every entry exactly matches the owned operation order", async () => {
    const first = await setup();
    try {
      const worker = first.workers[0]!;
      const original = worker.request.bind(worker);
      worker.request = async <T,>(command: Record<string, unknown>) => {
        const result = await original<T>(command);
        if (command.type === "set_session_name") {
          await appendFile(first.path, `${JSON.stringify({
            type: "session_info", id: "own-name", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z", name: "owned",
          })}\n${JSON.stringify({
            type: "session_info", id: "external-name", parentId: "own-name", timestamp: "2026-08-01T00:00:03.000Z", name: "external",
          })}\n`);
        }
        return result;
      };
      await expect(first.runtime.rename("session-a", "owned")).rejects.toThrow(/abort to recover/);
      expect((await first.runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await first.runtime.close();
    }

    const second = await setup();
    try {
      const worker = second.workers[0]!;
      const original = worker.request.bind(worker);
      worker.request = async <T,>(command: Record<string, unknown>) => {
        const result = await original<T>(command);
        if (command.type === "set_thinking_level") {
          await appendFile(second.path, `${JSON.stringify({
            type: "thinking_level_change", id: "own-thinking", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z", thinkingLevel: "high",
          })}\n${JSON.stringify({
            type: "message", id: "external-message", parentId: "own-thinking", timestamp: "2026-08-01T00:00:03.000Z",
            message: { role: "assistant", content: "external", timestamp: 3 },
          })}\n`);
        }
        return result;
      };
      await expect(second.runtime.setThinkingLevel("session-a", "high")).rejects.toThrow(/abort to recover/);
      expect((await second.runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await second.runtime.close();
    }
  });

  it("enters an addressed conflict on busy divergence, refuses mutation, and still allows abort", async () => {
    const { runtime, workers, path } = await setup();
    try {
      workers[0]!.emit("event", { type: "agent_start" });
      await appendFile(path, `${JSON.stringify({
        type: "message", id: "external", parentId: "u1", timestamp: "2026-08-01T00:00:03.000Z",
        message: { role: "assistant", content: "concurrent terminal", timestamp: 3 },
      })}\n`);
      await expect(runtime.rename("session-a", "must not write")).rejects.toThrow(/changed on disk/);
      expect(workers[0]!.commands.some((command) => command.type === "set_session_name")).toBe(false);
      const snapshot = await runtime.snapshot();
      expect(snapshot.runState).toBe("conflict");
      expect(snapshot.active?.projectionConflict?.message).toMatch(/changed on disk/);
      await runtime.abort("session-a");
      expect(workers[0]!.commands.some((command) => command.type === "abort")).toBe(false);
      expect(workers[0]!.stops).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("hard-stops and recovers a conflicted extension-blocked worker through abort", async () => {
    const { runtime, workers, path } = await setup();
    try {
      workers[0]!.emit("event", { type: "extension_ui_request", id: "blocked", method: "confirm", title: "Blocked" });
      await appendFile(path, `${JSON.stringify({
        type: "message", id: "external", parentId: "u1", timestamp: "2026-08-01T00:00:03.000Z",
        message: { role: "assistant", content: "external", timestamp: 3 },
      })}\n`);
      await expect(runtime.extensionUiResponse({ sessionId: "session-a", id: "blocked", confirmed: true })).rejects.toThrow(/abort to recover/);
      expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
      await runtime.abort("session-a");
      const recovered = await runtime.snapshot();
      expect(workers[0]!.stops).toBe(1);
      expect(recovered.runState).toBe("aborted");
      expect(recovered.pendingExtensionUiRequests).toEqual([]);
      expect(recovered.active?.projectionConflict).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it("serializes concurrent extension responses and sends only the winning response", async () => {
    const { runtime, workers } = await setup();
    try {
      workers[0]!.emit("event", { type: "extension_ui_request", id: "once", method: "confirm", title: "Once" });
      const responses = await Promise.allSettled([
        runtime.extensionUiResponse({ sessionId: "session-a", id: "once", confirmed: true }),
        runtime.extensionUiResponse({ sessionId: "session-a", id: "once", confirmed: false }),
      ]);
      expect(responses.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(responses.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(workers[0]!.commands.filter((command) => command.type === "extension_ui_response")).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("forwards stable lifecycle IDs and keeps equal-timestamp ordinary assistant messages distinct", async () => {
    const { runtime, workers } = await setup();
    try {
      const forwarded: Array<Record<string, unknown>> = [];
      runtime.on("event", (event) => {
        const record = event as Record<string, unknown>;
        if (String(record.type).startsWith("message_")) forwarded.push(record);
      });
      const first = { role: "assistant", content: "first", timestamp: 2 };
      workers[0]!.emit("event", { type: "message_start", message: first });
      workers[0]!.emit("event", { type: "message_update", message: { ...first, content: "first update" } });
      workers[0]!.emit("event", { type: "message_end", message: { ...first, content: "first final" } });
      const second = { role: "assistant", content: "second", timestamp: 2 };
      workers[0]!.emit("event", { type: "message_start", message: second });
      workers[0]!.emit("event", { type: "message_end", message: second });

      const ids = forwarded.map((event) => String((event.message as Record<string, unknown>).__inspireLiveId));
      expect(new Set(ids.slice(0, 3)).size).toBe(1);
      expect(ids[3]).toBe(ids[4]);
      expect(ids[3]).not.toBe(ids[0]);
      expect((await runtime.snapshot()).active?.messages.filter(
        (value) => (value as { role?: string; timestamp?: number }).role === "assistant" &&
          (value as { timestamp?: number }).timestamp === 2,
      )).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it("keeps equal-timestamp tool-result overlay messages distinct and reconciles both", async () => {
    const { runtime, workers, path } = await setup();
    try {
      workers[0]!.emit("event", { type: "agent_start" });
      const first = { role: "toolResult", content: "one", timestamp: 2, toolCallId: "call-1", toolName: "read" };
      const second = { role: "toolResult", content: "two", timestamp: 2, toolCallId: "call-2", toolName: "read" };
      for (const value of [first, second]) {
        workers[0]!.emit("event", { type: "message_start", message: value });
        workers[0]!.emit("event", { type: "message_end", message: value });
      }
      let snapshot = await runtime.snapshot();
      expect(snapshot.active?.messages.filter((value) => (value as { role?: string }).role === "toolResult")).toHaveLength(2);
      await appendFile(path, `${JSON.stringify({ type: "message", id: "tr1", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z", message: first })}\n${JSON.stringify({ type: "message", id: "tr2", parentId: "tr1", timestamp: "2026-08-01T00:00:03.000Z", message: second })}\n`);
      workers[0]!.emit("event", { type: "agent_settled" });
      await vi.waitFor(async () => {
        snapshot = await runtime.snapshot();
        expect(snapshot.runState).toBe("idle");
      });
      expect(snapshot.active?.messages.filter((value) => (value as { role?: string }).role === "toolResult")).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it.each(["same-inode", "atomic"] as const)("conflicts and stops a busy writer after a %s same-content source replacement", async (mode) => {
    const { runtime, workers, path } = await setup();
    try {
      await runtime.snapshot();
      const worker = workers[0]!;
      worker.emit("event", { type: "agent_start" });
      const bytes = await readFile(path);
      if (mode === "same-inode") await writeFile(path, bytes);
      else {
        const replacement = `${path}.replacement`;
        await writeFile(replacement, bytes);
        await rename(replacement, path);
      }
      await vi.waitFor(() => expect(worker.stops).toBe(1));
      expect((await runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await runtime.close();
    }
  });

  it.each(["same-inode", "atomic"] as const)("retires an idle writer after a %s same-content source replacement and starts fresh before writing", async (mode) => {
    const { runtime, workers, path } = await setup();
    try {
      await runtime.snapshot();
      const first = workers[0]!;
      const bytes = await readFile(path);
      if (mode === "same-inode") await writeFile(path, bytes);
      else {
        const replacement = `${path}.replacement`;
        await writeFile(replacement, bytes);
        await rename(replacement, path);
      }
      await vi.waitFor(() => expect(first.stops).toBe(1));
      expect((await runtime.snapshot()).runState).not.toBe("conflict");
      await runtime.prompt({ sessionId: "session-a", message: "fresh writer" });
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      expect(workers[1]!.commands).toContainEqual({ type: "prompt", message: "fresh writer" });
    } finally {
      await runtime.close();
    }
  });

  it("accepts an ordinary exactly owned append without a source-version false conflict", async () => {
    const { runtime, workers, path } = await setup();
    try {
      await runtime.snapshot();
      const worker = workers[0]!;
      const live = { role: "assistant", content: "ordinary", timestamp: 2 };
      worker.emit("event", { type: "agent_start" });
      worker.emit("event", { type: "message_end", message: live });
      await appendFile(path, `${JSON.stringify({
        type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z", message: live,
      })}\n`);
      await vi.waitFor(async () => expect((await runtime.snapshot()).active?.messages.at(-1)).toMatchObject({ content: "ordinary" }));
      expect(worker.stops).toBe(0);
      expect((await runtime.snapshot()).active?.projectionConflict).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it("stops an idle active writer on an unknown partial append and refuses a later prompt", async () => {
    const { runtime, workers, path } = await setup();
    try {
      await runtime.snapshot();
      await vi.waitFor(() => expect(workers[0]!.commands.some((command) => command.type === "get_commands")).toBe(true));
      await appendFile(path, JSON.stringify({ type: "message", id: "a1", parentId: "u1" }).slice(0, -2));
      await vi.waitFor(() => expect(workers[0]!.stops).toBe(1));
      await expect(runtime.prompt({ sessionId: "session-a", message: "must not concatenate" })).rejects.toThrow(/incomplete|unowned|changed/i);
      expect((await runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await runtime.close();
    }
  });

  it("refuses to start a writer for a pre-existing valid JSON object without its final LF", async () => {
    const validEntry = JSON.stringify({
      type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z",
      message: { role: "assistant", content: "not committed", timestamp: 2 },
    });
    const { runtime, workers } = await setup([], undefined, true, validEntry, false);
    try {
      await expect(runtime.prompt({ sessionId: "session-a", message: "must not be concatenated" })).rejects.toThrow(/incomplete JSONL/i);
      expect(workers).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it("fails startup closed when a partial append appears before attestation", async () => {
    const { runtime, workers } = await setup([], (worker) => {
      worker.onStart = async () => { await appendFile(worker.sessionPath, "{\"type\":\"message\""); };
    });
    try {
      await vi.waitFor(() => expect(workers[0]!.stops).toBeGreaterThanOrEqual(1));
      expect((await runtime.snapshot()).runState).toBe("failed");
      expect(workers[0]!.commands.some((command) => command.type === "get_commands")).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("waits for an owned partial append and accepts only its exact completed entry", async () => {
    const { runtime, workers, path } = await setup();
    try {
      const worker = workers[0]!;
      await runtime.snapshot();
      await vi.waitFor(() => expect(worker.commands.some((command) => command.type === "get_commands")).toBe(true));
      const live = { role: "assistant", content: "owned", timestamp: 2 };
      const entry = JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z", message: live });
      worker.emit("event", { type: "agent_start" });
      worker.emit("event", { type: "message_end", message: live });
      await appendFile(path, entry.slice(0, -16));
      const slot = (runtime as unknown as { slots: Map<string, { projection: { uncommittedBytes: number } }> }).slots.get("session-a")!;
      await vi.waitFor(() => expect(slot.projection.uncommittedBytes).toBeGreaterThan(0));
      const firstChunkBytes = slot.projection.uncommittedBytes;
      await appendFile(path, entry.slice(-16, -8));
      await vi.waitFor(() => expect(slot.projection.uncommittedBytes).toBeGreaterThan(firstChunkBytes));
      expect(worker.stops).toBe(0);
      await appendFile(path, `${entry.slice(-8)}\n`);
      await vi.waitFor(async () => {
        expect((await runtime.snapshot()).active?.messages.at(-1)).toMatchObject({ content: "owned" });
      });
      expect(worker.stops).toBe(0);
      worker.emit("event", { type: "agent_settled" });
    } finally {
      await runtime.close();
    }
  });

  it.each(["in-place", "atomic"] as const)("rejects an owned partial tail followed by a same-byte %s rewrite", async (mode) => {
    const { runtime, workers, path } = await setup();
    try {
      const worker = workers[0]!;
      await runtime.snapshot();
      worker.emit("event", { type: "agent_start" });
      await appendFile(path, "owned-partial-same-bytes");
      const slot = (runtime as unknown as { slots: Map<string, { projection: { uncommittedBytes: number } }> }).slots.get("session-a")!;
      await vi.waitFor(() => expect(slot.projection.uncommittedBytes).toBeGreaterThan(0));
      const bytes = await readFile(path);
      if (mode === "in-place") {
        await writeFile(path, bytes);
      } else {
        const replacement = `${path}.replacement`;
        await writeFile(replacement, bytes);
        await rename(replacement, path);
      }
      await vi.waitFor(() => expect(worker.stops).toBe(1));
      expect((await runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when an owned partial append never completes", async () => {
    const { runtime, workers, path } = await setup();
    try {
      const worker = workers[0]!;
      await runtime.snapshot();
      await vi.waitFor(() => expect(worker.commands.some((command) => command.type === "get_commands")).toBe(true));
      worker.emit("event", { type: "agent_start" });
      await appendFile(path, "{\"type\":\"message\"");
      await vi.waitFor(() => expect(worker.stops).toBe(1), { timeout: PARTIAL_PERSISTENCE_TIMEOUT_MS + 2_000 });
      expect((await runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await runtime.close();
    }
  });

  it.each(["truncate", "rewrite"] as const)("fails an owned partial append closed when its tail is %s", async (mode) => {
    const { runtime, workers, path } = await setup();
    try {
      const worker = workers[0]!;
      await runtime.snapshot();
      worker.emit("event", { type: "agent_start" });
      const slot = (runtime as unknown as { slots: Map<string, { projection: { committedBytes: number; uncommittedBytes: number } }> }).slots.get("session-a")!;
      const committed = slot.projection.committedBytes;
      await appendFile(path, "partial-owned-tail");
      await vi.waitFor(() => expect(slot.projection.uncommittedBytes).toBeGreaterThan(0));
      if (mode === "truncate") {
        await truncate(path, committed);
      } else {
        const prefix = (await readFile(path)).subarray(0, committed);
        await writeFile(path, Buffer.concat([prefix, Buffer.from("different-owned-tail")]));
      }
      await vi.waitFor(() => expect(worker.stops).toBe(1));
      expect((await runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await runtime.close();
    }
  });

  it.each([
    { command: "prompt", invoke: (runtime: RuntimeController) => runtime.prompt({ sessionId: "session-a", message: "late prompt" }), entry: { type: "message", id: "late", parentId: "u1", timestamp: "2026-08-01T00:00:03.000Z", message: { role: "user", content: "late prompt", timestamp: 3 } } },
    { command: "compact", invoke: (runtime: RuntimeController) => runtime.prompt({ sessionId: "session-a", message: "/compact" }), entry: { type: "compaction", id: "late", parentId: "u1", timestamp: "2026-08-01T00:00:03.000Z", summary: "late", firstKeptEntryId: "u1", tokensBefore: 10 } },
    { command: "set_session_name", invoke: (runtime: RuntimeController) => runtime.rename("session-a", "late name"), entry: { type: "session_info", id: "late", parentId: "u1", timestamp: "2026-08-01T00:00:03.000Z", name: "late name" } },
    { command: "set_model", invoke: (runtime: RuntimeController) => runtime.setModel("session-a", "provider", "model"), entry: { type: "model_change", id: "late", parentId: "u1", timestamp: "2026-08-01T00:00:03.000Z", provider: "provider", modelId: "model" } },
    { command: "set_thinking_level", invoke: (runtime: RuntimeController) => runtime.setThinkingLevel("session-a", "high"), entry: { type: "thinking_level_change", id: "late", parentId: "u1", timestamp: "2026-08-01T00:00:03.000Z", thinkingLevel: "high" } },
  ])("hard-stops and reconciles a late $command persistence after acceptance becomes unknown", async ({ command, invoke, entry }) => {
    const { runtime, workers, path } = await setup();
    try {
      const worker = workers[0]!;
      const original = worker.request.bind(worker);
      worker.request = async <T,>(request: Record<string, unknown>) => {
        if (request.type !== command) return original<T>(request);
        worker.commands.push(request);
        await appendFile(path, `${JSON.stringify(entry)}\n`);
        const error = new PiRpcOutcomeUnknownError(command);
        error.stopped = Promise.resolve();
        throw error;
      };
      await expect(invoke(runtime)).rejects.toThrow(/outcome is unknown/);
      expect(worker.stops).toBe(1);
      const snapshot = await runtime.snapshot();
      expect(snapshot.runState).toBe("conflict");
      expect(snapshot.active?.projectionConflict?.message).toMatch(/outcome is unknown/);
      expect(snapshot.active?.messages.some((message) => JSON.stringify(message).includes("late prompt")) || command !== "prompt").toBe(true);
      const dispatched = worker.commands.length;
      await expect(runtime.rename("session-a", "must not dispatch")).rejects.toThrow(/outcome is unknown/);
      expect(worker.commands).toHaveLength(dispatched);
    } finally {
      await runtime.close();
    }
  });

  it("close cancels an active mutation and drains queued event/projection tails", async () => {
    const { runtime, workers } = await setup();
    const worker = workers[0]!;
    const original = worker.request.bind(worker);
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => { mutationStarted = resolveStarted; });
    worker.request = async <T,>(command: Record<string, unknown>) => {
      if (command.type !== "set_session_name") return original<T>(command);
      mutationStarted();
      return new Promise<T>((_resolve, reject) => {
        worker.onStop = () => reject(new Error("worker stopped"));
      });
    };
    const mutation = runtime.rename("session-a", "closing");
    const mutationRejected = expect(mutation).rejects.toThrow(/worker stopped/);
    await started;
    workers[0]!.emit("event", { type: "agent_settled" });
    await expect(runtime.close()).resolves.toBeUndefined();
    await mutationRejected;
    expect(worker.stops).toBe(1);
  });

  it("uses a bounded live overlay for reconnect and removes it after persistence without duplicates", async () => {
    const { runtime, workers, path } = await setup();
    try {
      const live = { role: "assistant", content: [{ type: "text", text: "streaming".repeat(80_000) }], timestamp: 2 };
      workers[0]!.emit("event", { type: "agent_start" });
      workers[0]!.emit("event", { type: "message_start", message: live });
      let snapshot = await runtime.snapshot();
      expect(snapshot.active?.messages.filter((message) => (message as { timestamp?: number }).timestamp === 2)).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(snapshot.active?.transcriptPage))).toBeLessThanOrEqual(TRANSCRIPT_PAGE_MAX_BYTES);
      expect(Buffer.byteLength(JSON.stringify(snapshot.active?.messages))).toBeLessThanOrEqual(TRANSIENT_OVERLAY_MAX_BYTES);

      await appendFile(path, `${JSON.stringify({
        type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z", message: live,
      })}\n`);
      workers[0]!.emit("event", { type: "message_end", message: live });
      workers[0]!.emit("event", { type: "agent_settled" });
      await vi.waitFor(async () => {
        snapshot = await runtime.snapshot();
        expect(snapshot.runState).toBe("idle");
      });
      expect(snapshot.active?.messages.filter((message) => (message as { timestamp?: number }).timestamp === 2)).toHaveLength(1);
      expect(workers[0]!.commands.some((command) => command.type === "get_messages")).toBe(false);
    } finally {
      await runtime.close();
    }
  });
});
