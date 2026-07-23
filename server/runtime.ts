import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parseExtensionUiRequest,
  type ActiveSnapshot,
  type ExtensionUiRequest,
  type PromptRequest,
  type RunState,
  type SessionRuntimeStatus,
} from "../shared/contracts.js";
import { addAttachmentContext, AttachmentStore, resolveProjectFiles } from "./attachments.js";
import { PiRpcProcess, type PiRpcOptions } from "./pi-rpc.js";
import type { SessionCatalogLike, SessionRecord } from "./session-catalog.js";
import { loadSessionPreview, type ActiveSessionSnapshot } from "./session-preview.js";
import type { ResourceContext } from "./resources.js";

const REDACTED = "[redacted]";
const SENSITIVE_KEY = /(api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|token)$/i;
const BUSY_STATES = new Set<RunState>(["running", "retrying", "compacting", "queued"]);

export function safeProjection(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[depth limited]";
  if (typeof value === "string") return value.length > 250_000 ? `${value.slice(0, 250_000)}\n…[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 10_000).map((item) => safeProjection(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : safeProjection(child, depth + 1),
    ]),
  );
}

export interface RuntimeLike {
  readonly activeCwd: string | null;
  on(event: "event", listener: (event: unknown) => void): this;
  openSession(id: string): Promise<ActiveSnapshot>;
  newSession(cwdInput: string, name?: string): Promise<ActiveSnapshot>;
  prompt(request: PromptRequest): Promise<void>;
  abort(): Promise<void>;
  rename(name: string): Promise<void>;
  setModel(provider: string, modelId: string): Promise<unknown>;
  setThinkingLevel(level: string): Promise<void>;
  extensionUiResponse(response: Record<string, unknown>): Promise<void>;
  snapshot(): Promise<ActiveSnapshot>;
  resourceContext(sessionId: string): Promise<ResourceContext>;
  close(): Promise<void>;
}

type CompletionAttention = "completed" | "failed";

interface RuntimeSlot {
  id: string;
  cwd: string;
  sessionPath: string | null;
  process: PiRpcProcess | null;
  ready: boolean;
  preview: ActiveSessionSnapshot | null;
  runState: RunState;
  attention: CompletionAttention | null;
  pendingExtensionUi: ExtensionUiRequest | null;
  availableModels: unknown[] | null;
  commands: unknown[] | null;
}

export class RuntimeController extends EventEmitter implements RuntimeLike {
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly loadingSlots = new Map<string, Promise<RuntimeSlot>>();
  private readonly opening = new Map<string, Promise<RuntimeSlot>>();
  private selectedSessionId: string | null = null;
  private provisionalSequence = 0;

  constructor(
    private readonly catalog: SessionCatalogLike,
    private readonly attachments: AttachmentStore,
    private readonly createProcess: (options: PiRpcOptions) => PiRpcProcess = (options) => new PiRpcProcess(options),
    private readonly loadPreview: (session: SessionRecord) => Promise<ActiveSessionSnapshot> = loadSessionPreview,
  ) {
    super();
  }

  get activeCwd(): string | null {
    return this.selectedSlot()?.cwd ?? null;
  }

  private selectedSlot(): RuntimeSlot | null {
    return this.selectedSessionId ? (this.slots.get(this.selectedSessionId) ?? null) : null;
  }

  private requireSelectedSlot(): RuntimeSlot {
    const slot = this.selectedSlot();
    if (!slot) throw Object.assign(new Error("Open or create a session first"), { status: 409 });
    return slot;
  }

  private async requireSelectedReady(): Promise<RuntimeSlot & { process: PiRpcProcess }> {
    const slot = this.requireSelectedSlot();
    await this.ensureProcess(slot);
    if (!slot.process || !slot.ready) throw Object.assign(new Error("Pi runtime failed to start"), { status: 503 });
    return slot as RuntimeSlot & { process: PiRpcProcess };
  }

  private statusFor(slot: RuntimeSlot): SessionRuntimeStatus {
    const indicator = BUSY_STATES.has(slot.runState) ? "running" : (slot.attention ?? undefined);
    return { runState: slot.runState, ...(indicator ? { indicator } : {}) };
  }

  private sessionStatuses(): Record<string, SessionRuntimeStatus> {
    return Object.fromEntries([...this.slots].map(([id, slot]) => [id, this.statusFor(slot)]));
  }

  private emitSlotEvent(slot: RuntimeSlot, event: unknown): void {
    const projected = safeProjection(event);
    const body = projected && typeof projected === "object" && !Array.isArray(projected)
      ? projected as Record<string, unknown>
      : { type: "runtime_event", data: projected };
    this.emit("event", {
      ...body,
      sessionId: slot.id,
      sessionStatus: this.statusFor(slot),
    });
  }

  private handleEvent(slot: RuntimeSlot, event: unknown): void {
    const record = event && typeof event === "object" ? event as Record<string, unknown> : {};
    switch (record.type) {
      case "extension_ui_request":
        slot.pendingExtensionUi = parseExtensionUiRequest({ ...record, sessionId: slot.id }) ?? slot.pendingExtensionUi;
        break;
      case "agent_start":
        slot.runState = "running";
        slot.attention = null;
        break;
      case "compaction_start":
        slot.runState = "compacting";
        slot.attention = null;
        break;
      case "auto_retry_start":
        slot.runState = "retrying";
        break;
      case "auto_retry_end":
        slot.runState = record.success === false ? "failed" : "running";
        break;
      case "message_end": {
        const stopReason = (record.message as Record<string, unknown> | undefined)?.stopReason;
        if (stopReason === "aborted") slot.runState = "aborted";
        if (stopReason === "error") slot.runState = "failed";
        break;
      }
      case "agent_settled": {
        const outcome = slot.runState === "failed" ? "failed" : slot.runState === "aborted" ? null : "completed";
        slot.runState = slot.runState === "failed" ? "failed" : slot.runState === "aborted" ? "aborted" : "idle";
        slot.attention = this.selectedSessionId === slot.id ? null : outcome;
        this.catalog.invalidate();
        break;
      }
    }
    this.emitSlotEvent(slot, event);
  }

  private attachProcess(slot: RuntimeSlot, rpc: PiRpcProcess): void {
    rpc.on("event", (event) => this.handleEvent(slot, event));
    rpc.on("exit", (error: Error) => {
      if (slot.process !== rpc) return;
      slot.process = null;
      slot.ready = false;
      slot.runState = "failed";
      slot.attention = this.selectedSessionId === slot.id ? null : "failed";
      slot.pendingExtensionUi = null;
      this.emitSlotEvent(slot, { type: "runtime_error", error: error.message });
    });
  }

  private previewSnapshot(slot: RuntimeSlot): ActiveSnapshot {
    if (!slot.preview) throw new Error("Session preview is not available");
    return safeProjection({
      active: { ...slot.preview, isStreaming: false, isCompacting: false },
      runState: slot.runState,
      sessionStatuses: this.sessionStatuses(),
      pendingExtensionUi: slot.pendingExtensionUi,
    }) as ActiveSnapshot;
  }

  private async prepareSlot(session: SessionRecord): Promise<RuntimeSlot> {
    const existing = this.slots.get(session.id);
    if (existing && (existing.process || this.opening.has(session.id))) return existing;
    const pending = this.loadingSlots.get(session.id);
    if (pending) return pending;

    const loading = (async () => {
      const preview = await this.loadPreview(session);
      const current = this.slots.get(session.id);
      if (current && (current.process || this.opening.has(session.id))) return current;
      if (current) {
        current.preview = preview;
        current.cwd = preview.cwd;
        current.sessionPath = preview.sessionFile ? resolve(preview.sessionFile) : resolve(session.path);
        current.runState = "idle";
        current.pendingExtensionUi = null;
        return current;
      }

      const slot: RuntimeSlot = {
        id: session.id,
        cwd: preview.cwd,
        sessionPath: preview.sessionFile ? resolve(preview.sessionFile) : resolve(session.path),
        process: null,
        ready: false,
        preview,
        runState: "idle",
        attention: null,
        pendingExtensionUi: null,
        availableModels: null,
        commands: null,
      };
      this.slots.set(slot.id, slot);
      return slot;
    })();
    this.loadingSlots.set(session.id, loading);
    try {
      return await loading;
    } finally {
      this.loadingSlots.delete(session.id);
    }
  }

  private async startSlot(slot: RuntimeSlot): Promise<RuntimeSlot> {
    if (!slot.sessionPath) throw new Error("Session file is not available");
    const rpc = this.createProcess({ cwd: slot.cwd, args: ["--session", slot.sessionPath] });
    slot.process = rpc;
    slot.ready = false;
    slot.pendingExtensionUi = null;
    slot.availableModels = null;
    slot.commands = null;
    this.attachProcess(slot, rpc);
    try {
      await rpc.start();
      slot.ready = true;
      this.emitSlotEvent(slot, { type: "runtime_ready" });
      return slot;
    } catch (error) {
      if (slot.process === rpc) {
        slot.process = null;
        slot.ready = false;
        slot.runState = "failed";
        slot.attention = this.selectedSessionId === slot.id ? null : "failed";
        this.emitSlotEvent(slot, { type: "runtime_error", error: error instanceof Error ? error.message : String(error) });
      }
      await rpc.stop();
      throw error;
    }
  }

  private async ensureProcess(slot: RuntimeSlot): Promise<RuntimeSlot> {
    if (slot.process && slot.ready) return slot;
    const pending = this.opening.get(slot.id);
    if (pending) return pending;

    const opening = this.startSlot(slot);
    this.opening.set(slot.id, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(slot.id);
    }
  }

  async openSession(id: string): Promise<ActiveSnapshot> {
    const session = await this.catalog.get(id);
    if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });

    const slot = await this.prepareSlot(session);
    this.selectedSessionId = slot.id;
    slot.attention = null;
    if (slot.process && slot.ready) return this.snapshotSlot(slot);

    const snapshot = this.previewSnapshot(slot);
    void this.ensureProcess(slot).catch(() => undefined);
    return snapshot;
  }

  async newSession(cwdInput: string, name?: string): Promise<ActiveSnapshot> {
    const cwd = resolve(cwdInput);
    let details;
    try {
      details = await stat(cwd);
    } catch {
      throw Object.assign(new Error("Project path does not exist"), { status: 400 });
    }
    if (!details.isDirectory()) throw Object.assign(new Error("Project path is not a directory"), { status: 400 });

    const args = name?.trim() ? ["--name", name.trim().slice(0, 160)] : [];
    const rpc = this.createProcess({ cwd, args });
    const slot: RuntimeSlot = {
      id: `pending-${++this.provisionalSequence}`,
      cwd,
      sessionPath: null,
      process: rpc,
      ready: false,
      preview: null,
      runState: "idle",
      attention: null,
      pendingExtensionUi: null,
      availableModels: null,
      commands: null,
    };
    this.attachProcess(slot, rpc);
    try {
      await rpc.start();
      slot.ready = true;
      const state = await rpc.request<Record<string, unknown>>({ type: "get_state" });
      const sessionId = String(state.sessionId ?? "");
      if (!sessionId) throw new Error("Pi did not report a session id");
      if (this.slots.has(sessionId)) throw new Error("Pi created a duplicate session id");
      slot.id = sessionId;
      slot.sessionPath = typeof state.sessionFile === "string" ? resolve(state.sessionFile) : null;
      this.slots.set(sessionId, slot);
      this.selectedSessionId = sessionId;
      this.catalog.invalidate();
      this.emitSlotEvent(slot, { type: "runtime_ready" });
      return this.snapshotSlot(slot);
    } catch (error) {
      slot.process = null;
      slot.ready = false;
      await rpc.stop();
      throw error;
    }
  }

  async prompt(request: PromptRequest): Promise<void> {
    const slot = this.requireSelectedSlot();
    const message = request.message.trim();
    // Pi's RPC prompt does not interpret built-in slash commands (only
    // extension commands), so the host routes the one typed command it
    // supports — `/compact [instructions]` — to its RPC equivalent.
    const compact = /^\/compact(?:\s+([\s\S]+))?$/.exec(message);
    if (compact) {
      await this.compact(compact[1]?.trim() || undefined);
      return;
    }
    const [readySlot, resolved, projectFiles] = await Promise.all([
      this.ensureProcess(slot),
      this.attachments.resolveForPrompt(request.attachmentIds),
      resolveProjectFiles(slot.cwd, request.projectFiles),
    ]);
    if (!readySlot.process || !readySlot.ready) throw Object.assign(new Error("Pi runtime failed to start"), { status: 503 });
    const fullMessage = addAttachmentContext(message, resolved.files, projectFiles);
    if (!fullMessage && resolved.images.length === 0) throw new Error("Message or attachment is required");
    await readySlot.process.request({
      type: "prompt",
      message: fullMessage,
      ...(resolved.images.length > 0 ? { images: resolved.images } : {}),
      ...(request.behavior ? { streamingBehavior: request.behavior } : {}),
    });
  }

  async abort(): Promise<void> {
    const slot = await this.requireSelectedReady();
    await slot.process.request({ type: "abort" });
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const slot = await this.requireSelectedReady();
    return slot.process.request({ type: "compact", customInstructions }, 180_000);
  }

  async rename(name: string): Promise<void> {
    const slot = await this.requireSelectedReady();
    await slot.process.request({ type: "set_session_name", name: name.trim().slice(0, 160) });
    this.catalog.invalidate();
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const slot = await this.requireSelectedReady();
    return slot.process.request({ type: "set_model", provider, modelId });
  }

  async setThinkingLevel(level: string): Promise<void> {
    const slot = await this.requireSelectedReady();
    await slot.process.request({ type: "set_thinking_level", level });
  }

  async extensionUiResponse(response: Record<string, unknown>): Promise<void> {
    const sessionId = typeof response.sessionId === "string" ? response.sessionId : "";
    const requestId = typeof response.id === "string" ? response.id : "";
    const slot = this.slots.get(sessionId);
    if (!slot?.process || !slot.ready) {
      throw Object.assign(new Error("The extension request no longer has a live Pi runtime"), { status: 409 });
    }
    if (!slot.pendingExtensionUi || slot.pendingExtensionUi.id !== requestId) {
      throw Object.assign(new Error("The extension request is no longer pending"), { status: 409 });
    }
    const { sessionId: _owner, ...wireResponse } = response;
    slot.process.sendExtensionUiResponse(wireResponse);
    slot.pendingExtensionUi = null;
  }

  private async snapshotSlot(slot: RuntimeSlot): Promise<ActiveSnapshot> {
    const rpc = slot.process;
    if (!rpc || !slot.ready) return this.previewSnapshot(slot);
    const [state, messages, stats, models, commands] = await Promise.all([
      rpc.request<Record<string, unknown>>({ type: "get_state" }),
      rpc.request<{ messages: unknown[] }>({ type: "get_messages" }),
      rpc.request({ type: "get_session_stats" }).catch(() => undefined),
      slot.availableModels
        ? Promise.resolve(slot.availableModels)
        : rpc.request<{ models: unknown[] }>({ type: "get_available_models" }).then(
            (result) => (slot.availableModels = result.models),
            () => [],
          ),
      slot.commands
        ? Promise.resolve(slot.commands)
        : rpc.request<{ commands: unknown[] }>({ type: "get_commands" }).then(
            (result) => (slot.commands = result.commands),
            () => [],
          ),
    ]);
    slot.sessionPath = typeof state.sessionFile === "string" ? resolve(state.sessionFile) : slot.sessionPath;
    const snapshot = safeProjection({
      active: {
        sessionId: slot.id,
        sessionFile: slot.sessionPath ?? undefined,
        sessionName: typeof state.sessionName === "string" ? state.sessionName : undefined,
        cwd: slot.cwd,
        model: state.model,
        thinkingLevel: String(state.thinkingLevel ?? "off"),
        isStreaming: Boolean(state.isStreaming),
        isCompacting: Boolean(state.isCompacting),
        messages: messages.messages,
        stats,
        availableModels: models,
        commands,
      },
      runState: slot.runState,
      sessionStatuses: this.sessionStatuses(),
      pendingExtensionUi: slot.pendingExtensionUi,
    }) as ActiveSnapshot;
    if (snapshot.active) {
      slot.preview = { ...snapshot.active, isStreaming: false, isCompacting: false };
    }
    return snapshot;
  }

  async snapshot(): Promise<ActiveSnapshot> {
    const slot = this.selectedSlot();
    if (!slot) return { active: null, runState: "idle", sessionStatuses: this.sessionStatuses() };
    return slot.process && slot.ready ? this.snapshotSlot(slot) : this.previewSnapshot(slot);
  }

  async resourceContext(sessionId: string): Promise<ResourceContext> {
    const slot = this.selectedSlot();
    if (!slot || slot.id !== sessionId) {
      throw Object.assign(new Error("The resource does not belong to the visible session"), { status: 409 });
    }
    let messages = slot.preview?.messages ?? [];
    if (slot.process && slot.ready) {
      const current = await slot.process.request<{ messages: unknown[] }>({ type: "get_messages" });
      messages = current.messages;
    }
    return {
      sessionId: slot.id,
      cwd: slot.cwd,
      messages,
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.loadingSlots.values());
    await Promise.allSettled(this.opening.values());
    for (const slot of this.slots.values()) {
      const rpc = slot.process;
      slot.process = null;
      slot.ready = false;
      if (rpc) await rpc.stop();
    }
    this.slots.clear();
    this.selectedSessionId = null;
  }
}
