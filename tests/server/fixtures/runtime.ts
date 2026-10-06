import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expect, vi } from "vitest";
import { AttachmentStore } from "../../../server/attachments.js";
import type {
  PiRpcOptions,
  PiRpcResponseFence,
} from "../../../server/pi-rpc.js";
import type { RuntimeController } from "../../../server/runtime.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../../server/session-catalog.js";
import type { ActiveSessionSnapshot } from "../../../server/session-preview.js";
import {
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
  RETRY_STATE_SUFFIX,
  PENDING_IMAGE_SUFFIX,
} from "../../../shared/branch-bridge-protocol.js";
import { PreviewProjection } from "./preview-projection.js";

export class FakeRpc extends EventEmitter {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly uiResponses: Array<Record<string, unknown>> = [];
  starts = 0;
  stops = 0;
  retryReads = 0;
  retryState = true;
  confirmRetryState = true;
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
    this.sessionPath =
      marker >= 0
        ? resolve(options.args![marker + 1]!)
        : join(fixtureWorkspace, "new-id.jsonl");
    this.sessionId = this.sessionPath
      ? basename(this.sessionPath, ".jsonl")
      : "new-id";
  }

  async start(): Promise<void> {
    this.starts += 1;
    if (this.startupEvent) this.emit("event", this.startupEvent);
    if (this.startGate) await this.startGate;
  }

  async stop(_cancelledCommand?: string): Promise<void> {
    this.stops += 1;
  }

  async request<T>(
    command: Record<string, unknown>,
    _timeout?: number | null,
    fence?: PiRpcResponseFence,
  ): Promise<T> {
    if (
      command.type === "prompt" &&
      String(command.message).startsWith(
        `/${this.options.env!.INSPIRE_BRANCH_COMMAND}${RETRY_STATE_SUFFIX} `,
      )
    ) {
      this.retryReads += 1;
      if (this.confirmRetryState) {
        const request = decodeBranchBridgeJson(
          String(command.message).split(" ")[1],
          16_384,
        ) as object;
        this.emit("event", {
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: `${this.options.env!.INSPIRE_BRANCH_STATUS_KEY}${RETRY_STATE_SUFFIX}`,
          statusText: encodeBranchBridgeJson(
            { ...request, autoRetryEnabled: this.retryState },
            2_048,
          ),
        });
      }
      return { disposition: "handled" } as T;
    }
    if (
      command.type === "prompt" &&
      String(command.message).startsWith(
        `/${this.options.env!.INSPIRE_BRANCH_COMMAND}${PENDING_IMAGE_SUFFIX} `,
      )
    ) {
      const request = decodeBranchBridgeJson(
        String(command.message).split(" ")[1],
        16_384,
      ) as object;
      this.emit("event", {
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: `${this.options.env!.INSPIRE_BRANCH_STATUS_KEY}${PENDING_IMAGE_SUFFIX}`,
        statusText: encodeBranchBridgeJson({ ...request, cursor: null }, 2_048),
      });
      return { disposition: "handled" } as T;
    }
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
      const result = await value;
      if (fence) fence.received = true;
      return result as T;
    }
    let value: unknown;
    switch (command.type) {
      case "set_auto_retry":
        this.retryState = Boolean(command.enabled);
        value = {};
        break;
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
      case "clear_queue":
        value = { steering: [], followUp: [] };
        this.emit("event", { type: "queue_update", ...(value as object) });
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
    if (fence) fence.received = true;
    return value as T;
  }

  sendExtensionUiResponse(response: Record<string, unknown>): void {
    this.uiResponses.push(response);
  }
}

export const TEST_CWD = realpathSync(tmpdir());

export let fixtureWorkspace: string;

export let HIDDEN_FOLDER_CWD: string;

export function fixtureCwd(cwd: string): string {
  return /^\/(project|folder|loose|ordinary|hidden|other)(\/|$)/u.test(cwd)
    ? join(fixtureWorkspace, cwd.slice(1))
    : cwd;
}

export function record(id: string, cwd: string): SessionRecord {
  return {
    id,
    cwd: cwd === "/tmp" ? TEST_CWD : resolve(fixtureCwd(cwd)),
    path: resolve("/sessions", `${id}.jsonl`),
    source: null,
    created: new Date("2026-07-22T00:00:00Z"),
    modified: new Date("2026-07-22T00:00:00Z"),
    messageCount: 1,
    firstMessage: id,
    searchText: id,
  };
}

export async function waitForReady(
  runtime: RuntimeController,
  sessionId = "a",
) {
  const slots = (
    runtime as unknown as {
      slots: Map<string, { ready: boolean }>;
    }
  ).slots;
  await vi.waitFor(() => expect(slots.get(sessionId)?.ready).toBe(true));
}

export async function preview(
  session: SessionRecord,
): Promise<PreviewProjection> {
  return new PreviewProjection(session.id, await previewSnapshot(session));
}

export async function previewSnapshot(
  session: SessionRecord,
): Promise<ActiveSessionSnapshot> {
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
      composerHistoryVersion: "history-1",
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

export function catalog(records: SessionRecord[]): SessionCatalogLike {
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

export const workspaceDirectories: string[] = [];

export function trackedAttachmentStore(): AttachmentStore {
  const store = new AttachmentStore(
    join(fixtureWorkspace, `attachments-${attachments.length}`),
    null,
    {
      sessionDirectories: [fixtureWorkspace],
      trashDirectories: [],
      sweepIntervalMs: 0,
    },
  );
  attachments.push(store);
  return store;
}

export function deferredSignal(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function upload(name: string, type: string): Express.Multer.File {
  const buffer = Buffer.from("payload");
  return {
    originalname: name,
    mimetype: type,
    size: buffer.length,
    buffer,
  } as Express.Multer.File;
}

export async function initializeRuntimeFixture() {
  fixtureWorkspace = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-runtime-fixture-")),
  );
  workspaceDirectories.push(fixtureWorkspace);
  await Promise.all(
    [
      "project/one",
      "project/two",
      "folder",
      "loose",
      "ordinary",
      "hidden",
      "other",
    ].map((directory) =>
      mkdir(join(fixtureWorkspace, directory), { recursive: true }),
    ),
  );
  HIDDEN_FOLDER_CWD = fixtureCwd("/folder");
}

export async function disposeRuntimeFixture() {
  await Promise.all(attachments.splice(0).map((store) => store.close()));
  await Promise.all(
    workspaceDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}
