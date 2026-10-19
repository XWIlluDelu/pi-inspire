import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { AttachmentStore } from "../../../server/attachments.js";
import type { DiagnosticLogger } from "../../../server/diagnostics.js";
import {
  type PiRpcOptions,
  type PiRpcProcess,
} from "../../../server/pi-rpc.js";
import { RuntimeController } from "../../../server/runtime.js";
import type { SessionRecord } from "../../../server/session-catalog.js";
import { RETRY_STATE_SUFFIX } from "../../../shared/branch-bridge-protocol.js";

import { catalog, FakeRpc, workerAttachmentStore } from "./runtime.js";

export const directories: string[] = [];
export const stores: AttachmentStore[] = [];

export class ProjectionRpc extends FakeRpc {
  declare readonly sessionPath: string;
  onStop: (() => void) | null = null;
  onStart: (() => Promise<void>) | null = null;
  startupEntries: unknown[] = [];
  startupLeafId: string | null | undefined;
  stateThinkingLevel = "off";

  constructor(
    options: PiRpcOptions,
    private readonly sequence: string[],
  ) {
    super(options);
    this.responseOverrides.set("get_state", () => ({
      sessionId: "session-a",
      sessionFile: this.sessionPath,
      model: null,
      thinkingLevel: this.stateThinkingLevel,
      isStreaming: false,
      isCompacting: false,
    }));
    this.responseOverrides.set(
      "get_entries",
      (command: Record<string, unknown>) => ({
        entries: this.startupEntries,
        leafId:
          this.startupLeafId === undefined
            ? (command.since ?? null)
            : this.startupLeafId,
      }),
    );
  }
  override async start() {
    this.sequence.push("start");
    await this.onStart?.();
  }
  override async stop() {
    await super.stop();
    this.sequence.push("stop");
    this.onStop?.();
  }
  override async request<T>(command: Record<string, unknown>): Promise<T> {
    this.sequence.push(String(command.type));
    return super.request<T>(command);
  }
  override sendExtensionUiResponse(response: Record<string, unknown>) {
    this.commands.push({ type: "extension_ui_response", ...response });
  }
}

export class NewSessionRpc extends FakeRpc {
  declare readonly sessionPath: string;
  readonly entries: Array<Record<string, unknown>>;
  sessionName: string | undefined;
  emitEventsBeforeWrite = true;
  materializationCuts: number[] = [];
  onMaterializationCut: ((lineCount: number) => Promise<void>) | null = null;
  reusePromptTimestamps = false;
  unavailable = false;
  private promptCount = 0;
  private materialized = false;

  override get available(): boolean {
    return !this.unavailable;
  }
  private promptMessages: {
    user: Record<string, unknown>;
    assistant: Record<string, unknown>;
  } | null = null;

  constructor(
    options: PiRpcOptions,
    sessionPath: string,
    sessionId = "new-session",
  ) {
    super(options, sessionPath);
    this.sessionId = sessionId;
    this.entries = [
      {
        type: "model_change",
        id: "model-1",
        parentId: null,
        timestamp: "2026-08-01T00:00:01.000Z",
        provider: "test",
        modelId: "model",
      },
      {
        type: "thinking_level_change",
        id: "thinking-1",
        parentId: "model-1",
        timestamp: "2026-08-01T00:00:02.000Z",
        thinkingLevel: "medium",
      },
    ];
  }

  override async request<T>(command: Record<string, unknown>): Promise<T> {
    if (
      !["get_state", "get_entries", "set_session_name", "prompt"].includes(
        String(command.type),
      )
    ) {
      return super.request<T>(command);
    }
    if (
      command.type === "prompt" &&
      String(command.message).startsWith(
        `/${this.options.env!.INSPIRE_BRANCH_COMMAND}${RETRY_STATE_SUFFIX} `,
      )
    )
      return super.request<T>(command);
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
      const since =
        typeof command.since === "string"
          ? this.entries.findIndex((entry) => entry.id === command.since)
          : -1;
      const entries = since >= 0 ? this.entries.slice(since + 1) : this.entries;
      return {
        entries: structuredClone(entries),
        leafId: this.entries.at(-1)?.id ?? null,
      } as T;
    }
    if (command.type === "set_session_name") {
      this.sessionName = String(command.name ?? "");
      this.entries.push({
        type: "session_info",
        id: "name-1",
        parentId: this.entries.at(-1)?.id ?? null,
        timestamp: "2026-08-01T00:00:03.000Z",
        name: this.sessionName,
      });
      return {} as T;
    }
    if (command.type === "prompt") {
      const index = ++this.promptCount;
      const timestampIndex = this.reusePromptTimestamps ? 1 : index;
      const user = {
        role: "user",
        content: String(command.message ?? ""),
        timestamp: 2 + timestampIndex * 2,
      };
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        timestamp: 3 + timestampIndex * 2,
        stopReason: "stop",
      };
      this.promptMessages = { user, assistant };
      const promptEntries = [
        {
          type: "message",
          id: `user-${index}`,
          parentId: this.entries.at(-1)?.id ?? null,
          timestamp: `2026-08-01T00:00:${String(2 + index * 2).padStart(2, "0")}.000Z`,
          message: user,
        },
        {
          type: "message",
          id: `assistant-${index}`,
          parentId: `user-${index}`,
          timestamp: `2026-08-01T00:00:${String(3 + index * 2).padStart(2, "0")}.000Z`,
          message: assistant,
        },
      ];
      this.entries.push(...promptEntries);
      if (this.emitEventsBeforeWrite) this.emitPromptEvents();
      if (this.materialized) {
        await appendFile(
          this.sessionPath,
          `${promptEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        );
      } else {
        const header = {
          type: "session",
          version: 3,
          id: this.sessionId,
          timestamp: "2026-08-01T00:00:00.000Z",
          cwd: this.options.cwd,
        };
        const lines = [header, ...this.entries].map((entry) =>
          JSON.stringify(entry),
        );
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
        else if (written < lines.length)
          await appendFile(this.sessionPath, remainder);
        this.materialized = true;
      }
      return {} as T;
    }
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
}

export async function setupNewSession(
  configure?: (worker: NewSessionRpc) => void,
) {
  const directory = await mkdtemp(
    join(tmpdir(), "inspire-runtime-new-session-"),
  );
  directories.push(directory);
  const path = join(directory, "future-session.jsonl");
  const attachments = workerAttachmentStore(
    join(directory, "uploads"),
    directory,
  );
  stores.push(attachments);
  let worker!: NewSessionRpc;
  const runtime = new RuntimeController(catalog([]), attachments, (options) => {
    worker = new NewSessionRpc(options, path);
    configure?.(worker);
    return worker as unknown as PiRpcProcess;
  });
  return {
    directory,
    path,
    runtime,
    attachments,
    get worker() {
      return worker;
    },
  };
}

export async function setup(
  extraEntries: unknown[] = [],
  configure?: (worker: ProjectionRpc) => void,
  includeUser = true,
  trailingBytes = "",
  expectWorker = true,
  diagnostics?: DiagnosticLogger,
) {
  const directory = await mkdtemp(
    join(tmpdir(), "inspire-runtime-projection-"),
  );
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: "session-a",
    timestamp: "2026-08-01T00:00:00.000Z",
    cwd: directory,
  };
  const user = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-08-01T00:00:01.000Z",
    message: { role: "user", content: "original", timestamp: 1 },
  };
  await writeFile(
    path,
    `${[header, ...(includeUser ? [user] : []), ...extraEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n${trailingBytes}`,
  );
  const record: SessionRecord = {
    id: "session-a",
    cwd: directory,
    path,
    source: null,
    created: new Date(),
    modified: new Date(),
    messageCount: includeUser ? 1 : 0,
    firstMessage: "original",
    searchText: "original",
  };
  const source = catalog([record]);
  const attachments = workerAttachmentStore(
    join(directory, "uploads"),
    directory,
  );
  stores.push(attachments);
  const workers: ProjectionRpc[] = [];
  const sequence: string[] = [];
  const runtime = new RuntimeController(
    source,
    attachments,
    (options) => {
      const worker = new ProjectionRpc(options, sequence);
      configure?.(worker);
      workers.push(worker);
      return worker as unknown as PiRpcProcess;
    },
    undefined,
    undefined,
    undefined,
    undefined,
    diagnostics,
  );
  await runtime.openSession("session-a");
  if (expectWorker) await vi.waitFor(() => expect(workers).toHaveLength(1));
  return { runtime, workers, sequence, path };
}

export async function disposeProjectionFixture() {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}
