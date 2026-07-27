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
/** Keep a small warm cache, but never stop selected, busy, in-use, or
 * extension-blocked workers. Busy sessions may temporarily exceed the cap. */
export const MAX_IDLE_WORKERS = 3;

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

/** Matches a typed `/compact [instructions]` command. Pi's RPC prompt parses
 * only extension commands, not built-ins, so the host routes this one to its
 * RPC equivalent itself. One authority for the boundary; the mock reuses it. */
export function parseCompactCommand(message: string): { instructions?: string } | null {
  const match = /^\/compact(?:\s+([\s\S]+))?$/.exec(message.trim());
  if (!match) return null;
  const instructions = match[1]?.trim();
  return instructions ? { instructions } : {};
}

/** Full diagnostics stay in the host log; the browser only ever sees
 * `error.message`. */
function logRuntimeError(sessionId: string, error: unknown): void {
  const detail = (error as { detail?: unknown } | null)?.detail;
  console.error(`[pi ${sessionId}]`, error, ...(typeof detail === "string" ? [detail] : []));
}

export interface RuntimeLike {
  /** Id of the currently visible session; session-bound routes compare
   * against this so stale handles cannot outlive a selection change. */
  readonly activeSessionId: string | null;
  on(event: "event", listener: (event: unknown) => void): this;
  /** Working directory of an open session, or null when it is not open.
   * Project-file routes scope to the session the client names, never to
   * the host's current selection. */
  sessionCwd(sessionId: string): string | null;
  openSession(id: string): Promise<ActiveSnapshot>;
  newSession(cwdInput: string, name?: string): Promise<ActiveSnapshot>;
  prompt(request: PromptRequest): Promise<void>;
  abort(sessionId: string): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  setModel(sessionId: string, provider: string, modelId: string): Promise<unknown>;
  setThinkingLevel(sessionId: string, level: string): Promise<void>;
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
  /** A reclaimed worker must finish stopping before the same session starts
   * another one, preserving Pi's one-writer-per-session rule. */
  stopping: Promise<void> | null;
  ready: boolean;
  preview: ActiveSessionSnapshot | null;
  runState: RunState;
  attention: CompletionAttention | null;
  pendingExtensionUi: ExtensionUiRequest | null;
  availableModels: unknown[] | null;
  commands: unknown[] | null;
  lastUsed: number;
  activeOperations: number;
  messageRevision: number;
  previewRevision: number;
}

export class RuntimeController extends EventEmitter implements RuntimeLike {
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly loadingSlots = new Map<string, Promise<RuntimeSlot>>();
  private readonly opening = new Map<string, Promise<RuntimeSlot>>();
  private selectedSessionId: string | null = null;
  /** Monotonic selection age: a slower, earlier open/new completion must not
   * steal the selection back from a newer one. */
  private selectionSequence = 0;
  private provisionalSequence = 0;
  private useSequence = 0;
  private workerMaintenance: Promise<void> = Promise.resolve();
  private workerMaintenanceRunning = false;
  private workerMaintenanceRequested = false;
  private closing = false;

  constructor(
    private readonly catalog: SessionCatalogLike,
    private readonly attachments: AttachmentStore,
    private readonly createProcess: (options: PiRpcOptions) => PiRpcProcess = (options) => new PiRpcProcess(options),
    private readonly loadPreview: (session: SessionRecord) => Promise<ActiveSessionSnapshot> = loadSessionPreview,
  ) {
    super();
  }

  get activeSessionId(): string | null {
    return this.selectedSessionId;
  }

  sessionCwd(sessionId: string): string | null {
    return this.slots.get(sessionId)?.cwd ?? null;
  }

  private selectedSlot(): RuntimeSlot | null {
    return this.selectedSessionId ? (this.slots.get(this.selectedSessionId) ?? null) : null;
  }

  private touch(slot: RuntimeSlot): void {
    slot.lastUsed = ++this.useSequence;
  }

  /** Protect an RPC operation from idle-worker reclamation. */
  private async useSlot<T>(slot: RuntimeSlot, operation: () => Promise<T>): Promise<T> {
    slot.activeOperations += 1;
    this.touch(slot);
    try {
      return await operation();
    } finally {
      slot.activeOperations -= 1;
      this.scheduleIdleWorkerEviction();
    }
  }

  private scheduleIdleWorkerEviction(): void {
    if (this.closing) return;
    this.workerMaintenanceRequested = true;
    if (this.workerMaintenanceRunning) return;
    this.workerMaintenanceRunning = true;
    this.workerMaintenance = this.runWorkerMaintenance();
  }

  private async runWorkerMaintenance(): Promise<void> {
    try {
      while (this.workerMaintenanceRequested && !this.closing) {
        this.workerMaintenanceRequested = false;
        await this.evictIdleWorkers();
      }
    } catch (error) {
      console.error("Failed to reclaim an idle Pi worker", error);
    } finally {
      this.workerMaintenanceRunning = false;
      if (this.workerMaintenanceRequested && !this.closing) this.scheduleIdleWorkerEviction();
    }
  }

  private async evictIdleWorkers(): Promise<void> {
    const candidates = [...this.slots.values()]
      .filter((slot) => this.canEvict(slot))
      .sort((left, right) => left.lastUsed - right.lastUsed);
    const excess = candidates.length - MAX_IDLE_WORKERS;
    if (excess <= 0) return;

    const stopping: Promise<void>[] = [];
    for (const slot of candidates) {
      if (stopping.length >= excess) break;
      // Detach every selected worker synchronously before awaiting any stop;
      // independent 1.5 s force-kill windows then run in parallel.
      if (!this.canEvict(slot)) continue;
      const rpc = slot.process;
      if (!rpc) continue;
      slot.process = null;
      slot.ready = false;
      // The read-only transcript can be large; it is reloadable from Pi's
      // session file and must not turn the lightweight slot registry into a
      // second unbounded conversation cache.
      slot.preview = null;
      slot.previewRevision = -1;
      slot.availableModels = null;
      slot.commands = null;
      const stop = rpc.stop().catch((error) => logRuntimeError(slot.id, error));
      slot.stopping = stop;
      stopping.push(
        stop.finally(() => {
          if (slot.stopping === stop) slot.stopping = null;
        }),
      );
    }
    await Promise.all(stopping);
  }

  private canEvict(slot: RuntimeSlot): boolean {
    return Boolean(
      slot.process &&
      slot.ready &&
      slot.id !== this.selectedSessionId &&
      !BUSY_STATES.has(slot.runState) &&
      !slot.pendingExtensionUi &&
      slot.activeOperations === 0 &&
      !this.opening.has(slot.id),
    );
  }

  /** Writes are addressed: the caller names the session, and a concurrent
   * selection change on the host can never redirect them. */
  private requireSlot(sessionId: string): RuntimeSlot {
    const slot = this.slots.get(sessionId);
    if (!slot) throw Object.assign(new Error("That session is not open on this host"), { status: 409 });
    return slot;
  }

  private async ensureReady(slot: RuntimeSlot): Promise<RuntimeSlot & { process: PiRpcProcess }> {
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
    // A slot enters the registry only under its final Pi session id. Before
    // that (newSession's provisional phase) its events would broadcast an
    // unaddressable `pending-*` id, so they stay local; the creating request
    // returns the full state once the real id is known.
    if (this.slots.get(slot.id) !== slot) return;
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
    if (record.type === "message_start" || record.type === "message_update" || record.type === "message_end") {
      slot.messageRevision += 1;
    }
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
        this.scheduleIdleWorkerEviction();
        break;
      }
    }
    this.emitSlotEvent(slot, event);
  }

  private attachProcess(slot: RuntimeSlot, rpc: PiRpcProcess): void {
    rpc.on("event", (event) => {
      if (slot.process === rpc) this.handleEvent(slot, event);
    });
    rpc.on("exit", (error: Error) => {
      if (slot.process !== rpc) return;
      slot.process = null;
      slot.ready = false;
      slot.runState = "failed";
      slot.attention = this.selectedSessionId === slot.id ? null : "failed";
      slot.pendingExtensionUi = null;
      logRuntimeError(slot.id, error);
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
        current.previewRevision = current.messageRevision;
        return current;
      }

      const slot: RuntimeSlot = {
        id: session.id,
        cwd: preview.cwd,
        sessionPath: preview.sessionFile ? resolve(preview.sessionFile) : resolve(session.path),
        process: null,
        stopping: null,
        ready: false,
        preview,
        runState: "idle",
        attention: null,
        pendingExtensionUi: null,
        availableModels: null,
        commands: null,
        lastUsed: 0,
        activeOperations: 0,
        messageRevision: 0,
        previewRevision: 0,
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
    if (slot.stopping) await slot.stopping;
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
      this.scheduleIdleWorkerEviction();
      return slot;
    } catch (error) {
      if (slot.process === rpc) {
        slot.process = null;
        slot.ready = false;
        slot.runState = "failed";
        slot.attention = this.selectedSessionId === slot.id ? null : "failed";
        logRuntimeError(slot.id, error);
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
      this.scheduleIdleWorkerEviction();
    }
  }

  async openSession(id: string): Promise<ActiveSnapshot> {
    const selection = ++this.selectionSequence;
    const session = await this.catalog.get(id);
    if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });

    const slot = await this.prepareSlot(session);
    if (selection === this.selectionSequence) {
      this.selectedSessionId = slot.id;
      slot.attention = null;
      this.touch(slot);
      this.scheduleIdleWorkerEviction();
    }
    if (slot.process && slot.ready) return this.snapshotSlot(slot);

    const snapshot = this.previewSnapshot(slot);
    void this.ensureProcess(slot).catch(() => undefined);
    return snapshot;
  }

  async newSession(cwdInput: string, name?: string): Promise<ActiveSnapshot> {
    const selection = ++this.selectionSequence;
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
      stopping: null,
      ready: false,
      preview: null,
      runState: "idle",
      attention: null,
      pendingExtensionUi: null,
      availableModels: null,
      commands: null,
      lastUsed: 0,
      activeOperations: 0,
      messageRevision: 0,
      previewRevision: -1,
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
      // An extension may have asked for input while the slot still carried
      // its provisional id; rebind the request so it is answerable through
      // the final session identity.
      if (slot.pendingExtensionUi) slot.pendingExtensionUi = { ...slot.pendingExtensionUi, sessionId };
      this.slots.set(sessionId, slot);
      if (selection === this.selectionSequence) {
        this.selectedSessionId = sessionId;
        this.touch(slot);
        this.scheduleIdleWorkerEviction();
      }
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
    const slot = this.requireSlot(request.sessionId);
    await this.useSlot(slot, async () => {
      const message = request.message.trim();
      // A bare typed /compact runs the compaction control. With attachments or
      // file references present the text is not a command and flows through as
      // an ordinary prompt, so nothing the user staged is silently dropped.
      const compact = parseCompactCommand(message);
      if (compact && !request.attachmentIds?.length && !request.projectFiles?.length) {
        await this.compactSlot(slot, compact.instructions);
        return;
      }
      const resolving = this.attachments.resolveForPrompt(request.attachmentIds);
      try {
        const [readySlot, resolved, projectFiles] = await Promise.all([
          this.ensureProcess(slot),
          resolving,
          resolveProjectFiles(slot.cwd, request.projectFiles),
        ]);
        if (!readySlot.process || !readySlot.ready) {
          throw Object.assign(new Error("Pi runtime failed to start"), { status: 503 });
        }
        const fullMessage = addAttachmentContext(message, resolved.files, projectFiles);
        if (!fullMessage && resolved.images.length === 0) throw new Error("Message or attachment is required");
        const previousRunState = slot.runState;
        // Pi acknowledges prompt acceptance before agent_start can cross the
        // event channel. Mark the handoff queued so idle reclamation cannot
        // stop the worker in that gap.
        slot.runState = "queued";
        try {
          await readySlot.process.request({
            type: "prompt",
            message: fullMessage,
            ...(resolved.images.length > 0 ? { images: resolved.images } : {}),
            ...(request.behavior ? { streamingBehavior: request.behavior } : {}),
          });
        } catch (error) {
          if (slot.runState === "queued") slot.runState = previousRunState;
          throw error;
        }
      } catch (error) {
        // Failed delivery hands leased attachments back to the staged state,
        // so the client can still withdraw or resend them — but only when this
        // prompt's resolve took the leases: a rejected resolve holds nothing,
        // and a lease held by a concurrent prompt must not be disturbed. The
        // handback settles before the failure response goes out, because the
        // client may react to the error instantly by withdrawing the files.
        try {
          await resolving;
          this.attachments.restage(request.attachmentIds);
        } catch {
          // The resolve rolled its own leases back when it rejected.
        }
        throw error;
      }
      // Delivered: image bytes travelled inside the request, so their upload
      // cache entries are no longer needed. File attachments stay (their host
      // paths are part of the conversation text).
      if (request.attachmentIds?.length) await this.attachments.releaseConsumed(request.attachmentIds);
    });
  }

  async abort(sessionId: string): Promise<void> {
    const slot = this.requireSlot(sessionId);
    await this.useSlot(slot, async () => {
      const ready = await this.ensureReady(slot);
      await ready.process.request({ type: "abort" });
    });
  }

  private async compactSlot(slot: RuntimeSlot, customInstructions?: string): Promise<unknown> {
    const ready = await this.ensureReady(slot);
    const previousRunState = slot.runState;
    slot.runState = "compacting";
    try {
      const result = await ready.process.request({ type: "compact", customInstructions }, 180_000);
      if (slot.runState === "compacting") slot.runState = "idle";
      return result;
    } catch (error) {
      if (slot.runState === "compacting") slot.runState = previousRunState;
      throw error;
    }
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const slot = this.requireSlot(sessionId);
    await this.useSlot(slot, async () => {
      const ready = await this.ensureReady(slot);
      await ready.process.request({ type: "set_session_name", name: name.trim().slice(0, 160) });
      this.catalog.invalidate();
    });
  }

  async setModel(sessionId: string, provider: string, modelId: string): Promise<unknown> {
    const slot = this.requireSlot(sessionId);
    return this.useSlot(slot, async () => {
      const ready = await this.ensureReady(slot);
      return ready.process.request({ type: "set_model", provider, modelId });
    });
  }

  async setThinkingLevel(sessionId: string, level: string): Promise<void> {
    const slot = this.requireSlot(sessionId);
    await this.useSlot(slot, async () => {
      const ready = await this.ensureReady(slot);
      await ready.process.request({ type: "set_thinking_level", level });
    });
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
    await this.useSlot(slot, async () => {
      const rpc = slot.process;
      if (!rpc || !slot.ready) {
        throw Object.assign(new Error("The extension request no longer has a live Pi runtime"), { status: 409 });
      }
      rpc.sendExtensionUiResponse(wireResponse);
      slot.pendingExtensionUi = null;
      // stdin is ordered: a get_state response proves Pi consumed the
      // preceding fire-and-forget extension response before reclamation can
      // consider this worker idle.
      await rpc.request({ type: "get_state" });
    });
  }

  private async snapshotSlot(slot: RuntimeSlot): Promise<ActiveSnapshot> {
    return this.useSlot(slot, async () => {
      const rpc = slot.process;
      if (!rpc || !slot.ready) return this.previewSnapshot(slot);
      const messageRevision = slot.messageRevision;
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
        slot.previewRevision = slot.messageRevision === messageRevision ? messageRevision : -1;
      }
      return snapshot;
    });
  }

  async snapshot(): Promise<ActiveSnapshot> {
    while (true) {
      const slot = this.selectedSlot();
      if (!slot) return { active: null, runState: "idle", sessionStatuses: this.sessionStatuses() };
      const snapshot = slot.process && slot.ready ? await this.snapshotSlot(slot) : this.previewSnapshot(slot);
      // The RPC reads above may have overlapped a newer open/new selection.
      // Only a snapshot of the still-selected slot is authoritative.
      if (this.selectedSessionId === slot.id) return snapshot;
    }
  }

  async resourceContext(sessionId: string): Promise<ResourceContext> {
    const slot = this.selectedSlot();
    if (!slot || slot.id !== sessionId) {
      throw Object.assign(new Error("The resource does not belong to the visible session"), { status: 409 });
    }
    return {
      sessionId: slot.id,
      cwd: slot.cwd,
      loadMessages: () => this.resourceMessages(slot),
    };
  }

  private async resourceMessages(slot: RuntimeSlot): Promise<unknown[]> {
    return this.useSlot(slot, async () => {
      if (this.selectedSessionId !== slot.id) {
        throw Object.assign(new Error("The resource does not belong to the visible session"), { status: 409 });
      }
      if (slot.preview && slot.previewRevision === slot.messageRevision) return slot.preview.messages;

      let messages = slot.preview?.messages ?? [];
      const revision = slot.messageRevision;
      if (slot.process && slot.ready) {
        const current = await slot.process.request<{ messages: unknown[] }>({ type: "get_messages" });
        // The user may have switched sessions while the fetch was in flight;
        // serving would leak the old session's content into the new view.
        if (this.selectedSessionId !== slot.id) {
          throw Object.assign(new Error("The resource does not belong to the visible session"), { status: 409 });
        }
        messages = current.messages;
      }
      if (slot.preview && slot.messageRevision === revision) {
        slot.preview = { ...slot.preview, messages };
        slot.previewRevision = revision;
      }
      return messages;
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.loadingSlots.values());
    await Promise.allSettled(this.opening.values());
    await this.workerMaintenance;
    for (const slot of this.slots.values()) {
      const rpc = slot.process;
      slot.process = null;
      slot.ready = false;
      if (rpc) await rpc.stop();
      if (slot.stopping) await slot.stopping;
    }
    this.slots.clear();
    this.selectedSessionId = null;
  }
}
