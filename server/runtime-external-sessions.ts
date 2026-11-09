import type {
  ModelCatalog as NativeModelCatalog,
  ModelSelection as NativeModelSelection,
} from "../extensions/attach-control.js";
import {
  type ComposerHistoryEntry,
  isBusyRunState,
  MAX_PROMPT_CHARS,
  type PromptRequest,
} from "../shared/contracts.js";
import {
  type AttachmentStore,
  addAttachmentContext,
  resolveProjectFiles,
} from "./attachments.js";
import type {
  AttachmentEnd,
  ConnectExternalSession,
  ExternalSessionConnection,
  ExternalSessionState,
} from "./external-session.js";
import { requestError } from "./request-error.js";
import {
  assertPromptArtifactBudget,
  resolveComposerHistoryArtifacts,
  revalidateProjectFiles,
} from "./runtime-composer-artifacts.js";
import type { RuntimeSlot } from "./runtime-slot.js";

interface Connection {
  native: ExternalSessionConnection;
  state: ExternalSessionState;
  timer?: ReturnType<typeof setTimeout>;
  /** The last read failed; logged once per failure run. */
  failing: boolean;
  sending: number;
  selectionRevision: number;
  modelRefresh?: Promise<NativeModelCatalog>;
}

interface ExternalSessionHost {
  current(slot: RuntimeSlot): boolean;
  emit(slot: RuntimeSlot, event: unknown): void;
  reconcile(slot: RuntimeSlot, force: boolean): Promise<unknown>;
  assertUsable(slot: RuntimeSlot): void;
  log(slot: RuntimeSlot, error: unknown): void;
  released(slot: RuntimeSlot): void;
  syncUi?(
    slot: RuntimeSlot,
    requests: Record<string, unknown>[],
    owner: ExternalSessionConnection,
  ): void;
  /** Whether a leaf still continues this view's branch. */
  corresponds(slot: RuntimeSlot, leafId: string | null): boolean;
}

/** Conversation access to externally owned sessions, deliberately outside the
 * owned-worker pool, RPC persistence attestations and process retirement. */
export class RuntimeExternalSessions {
  private readonly connections = new Map<RuntimeSlot, Connection>();
  private readonly connecting = new Map<RuntimeSlot, Promise<boolean>>();
  private closed = false;

  constructor(
    private readonly connector: ConnectExternalSession,
    private readonly host: ExternalSessionHost,
    private readonly attachments: AttachmentStore,
    private readonly pollMs = 750,
  ) {}

  has(slot: RuntimeSlot): boolean {
    return this.connections.has(slot);
  }

  connection(slot: RuntimeSlot): ExternalSessionConnection | undefined {
    return this.connections.get(slot)?.native;
  }

  /** The attached Pi's current leaf; undefined when not attached. */
  reportedLeaf(slot: RuntimeSlot): string | null | undefined {
    return this.connections.get(slot)?.state.leafId;
  }

  modelSelection(slot: RuntimeSlot): NativeModelSelection | undefined {
    return this.connections.get(slot)?.state.modelSelection;
  }

  async models(slot: RuntimeSlot): Promise<NativeModelCatalog> {
    const c = this.modelConnection(slot);
    if (c.modelRefresh) return c.modelRefresh;
    const selectionRevision = c.selectionRevision;
    const instanceId = c.state.taskRuns?.instanceId;
    const pending = c.native.models().then((result) => {
      if (c.modelRefresh !== pending)
        throw requestError("The native Pi model receiver changed.", 409);
      // Catalog reads run alongside setters. A delayed read can still supply
      // models, but cannot undo a selection completed/observed since it began.
      const current =
        c.selectionRevision === selectionRevision
          ? result
          : { ...result, ...c.state.modelSelection };
      this.applyModelState(slot, c, current, instanceId);
      return current;
    });
    c.modelRefresh = pending;
    try {
      return await pending;
    } finally {
      if (c.modelRefresh === pending) c.modelRefresh = undefined;
    }
  }

  private modelConnection(slot: RuntimeSlot): Connection {
    const c = this.connections.get(slot);
    if (!c)
      throw requestError("The attached Pi connection has ended.", 409, {
        code: "SESSION_OWNER_UNAVAILABLE",
      });
    this.host.assertUsable(slot);
    return c;
  }

  private applyModelState(
    slot: RuntimeSlot,
    c: Connection,
    state: NativeModelSelection | NativeModelCatalog,
    instanceId: string | undefined,
  ): void {
    if (this.connections.get(slot) !== c || !this.host.current(slot))
      throw requestError("The external Pi connection has ended.", 409);
    if (c.state.taskRuns?.instanceId !== instanceId)
      throw requestError("The native Pi model receiver changed.", 409);
    if ("models" in state) slot.availableModels = state.models;
    c.selectionRevision++;
    c.state = {
      ...c.state,
      modelSelection: {
        model: state.model,
        thinkingLevel: state.thinkingLevel,
      },
    };
    this.host.emit(slot, { type: "model_metadata_changed" });
  }

  async setModel(
    slot: RuntimeSlot,
    provider: string,
    modelId: string,
  ): Promise<NativeModelSelection> {
    return this.changeSelection(slot, (native, beforeSend) =>
      native.setModel(provider, modelId, beforeSend),
    );
  }

  async setThinkingLevel(
    slot: RuntimeSlot,
    level: NativeModelSelection["thinkingLevel"],
  ): Promise<NativeModelSelection> {
    return this.changeSelection(slot, (native, beforeSend) =>
      native.setThinkingLevel(level, beforeSend),
    );
  }

  private async changeSelection(
    slot: RuntimeSlot,
    change: (
      native: ExternalSessionConnection,
      beforeSend: () => void,
    ) => Promise<NativeModelSelection>,
  ): Promise<NativeModelSelection> {
    const c = this.modelConnection(slot);
    const instanceId = c.state.taskRuns?.instanceId;
    const result = await change(c.native, () => {
      if (this.connections.get(slot) !== c)
        throw requestError("The external Pi connection has ended.", 409);
      if (c.state.taskRuns?.instanceId !== instanceId)
        throw requestError("The native Pi model receiver changed.", 409);
      this.host.assertUsable(slot);
    });
    this.applyModelState(slot, c, result, instanceId);
    await this.host.reconcile(slot, false);
    return { model: result.model, thinkingLevel: result.thinkingLevel };
  }

  needsInput(slot: RuntimeSlot): boolean {
    return this.connections.get(slot)?.state.status === "blocked";
  }

  async connect(
    slot: RuntimeSlot,
    accepts: (leafId: string | null) => boolean = () => true,
  ): Promise<boolean> {
    const pending = this.connecting.get(slot);
    if (pending) return pending;
    const operation = this.connectInside(slot, accepts);
    this.connecting.set(slot, operation);
    try {
      return await operation;
    } finally {
      if (this.connecting.get(slot) === operation) this.connecting.delete(slot);
    }
  }

  private async connectInside(
    slot: RuntimeSlot,
    accepts: (leafId: string | null) => boolean,
  ): Promise<boolean> {
    if (this.closed || slot.process || !slot.sessionPath) return false;
    const previous = this.connections.get(slot);
    if (previous) {
      const selectionRevision = previous.selectionRevision;
      let state:
        | Awaited<ReturnType<ExternalSessionConnection["read"]>>
        | undefined;
      try {
        state = await previous.native.read();
      } catch {
        // A transient failure keeps the attachment; its poll continues.
      }
      if (this.closed || !this.host.current(slot) || slot.process) return false;
      // The owner poll may have retired this connection during the read.
      if (this.connections.get(slot) === previous) {
        if (state === undefined) return true;
        if (!("ended" in state) && accepts(state.leafId ?? null)) {
          previous.failing = false;
          this.applyState(slot, previous, state, false, selectionRevision);
          return true;
        }
        // Another corresponding instance may still be attached below.
        this.end(slot, "ended" in state ? state.ended : "left-branch", false);
      }
    }
    const native = await this.connector(slot.id, slot.sessionPath, accepts);
    if (native === null) return false;
    if (this.closed || !this.host.current(slot) || slot.process) {
      native.close();
      return false;
    }
    let state: Awaited<ReturnType<ExternalSessionConnection["read"]>>;
    try {
      state = await native.read();
    } catch (error) {
      // Not attached: a retried takeover or the next open decides again.
      native.close();
      throw error;
    }
    if (
      "ended" in state ||
      !accepts(state.leafId ?? null) ||
      this.closed ||
      !this.host.current(slot) ||
      slot.process
    ) {
      native.close();
      return false;
    }
    const connection: Connection = {
      native,
      state,
      failing: false,
      sending: 0,
      selectionRevision: 0,
    };
    this.detach(slot, native);
    this.connections.set(slot, connection);
    // Attached Pi accepts input: the view is no longer read-only.
    if (slot.readOnlyReason === "external-active") slot.readOnlyReason = null;
    this.applyState(slot, connection, state, true);
    this.schedule(slot, connection);
    this.host.emit(slot, { type: "runtime_ready" });
    return true;
  }

  private applyState(
    slot: RuntimeSlot,
    connection: Connection,
    state: ExternalSessionState,
    force = false,
    selectionRevision = connection.selectionRevision,
  ): void {
    // Ownership validation can finish after a newer selection. Fence at the
    // state commit while retaining this observation's activity and capability.
    if (selectionRevision !== connection.selectionRevision)
      state = { ...state, modelSelection: connection.state.modelSelection };
    const priorState = connection.state;
    const changed = priorState.status !== state.status;
    const selectionChanged =
      JSON.stringify(priorState.modelSelection) !==
      JSON.stringify(state.modelSelection);
    const receiverChanged =
      priorState.taskRuns?.instanceId !== state.taskRuns?.instanceId;
    connection.state = state;
    this.host.syncUi?.(slot, state.uiRequests ?? [], connection.native);
    if (selectionChanged) connection.selectionRevision++;
    if (force || receiverChanged) {
      slot.availableModels = null;
      // A reload can replace the action receiver without ending the Pi process.
      // New discovery must not join or publish the retired receiver's result.
      connection.modelRefresh = undefined;
    }
    if (selectionChanged || receiverChanged) {
      this.host.emit(slot, { type: "model_metadata_changed" });
    }
    const sameReceiver =
      !force &&
      state.taskRuns &&
      priorState.taskRuns?.instanceId === state.taskRuns.instanceId;
    const oldResults = new Set(
      priorState.taskRuns?.settled.map((item) => item.id),
    );
    const newResults = sameReceiver
      ? state.taskRuns!.settled.filter(
          (item) =>
            !oldResults.has(item.id) &&
            item.settledAt > Date.now() - 15 * 60_000,
        )
      : [];
    for (const result of newResults) {
      this.host.emit(slot, {
        type: "native_task_outcome",
        outcomeId: state.taskRuns!.instanceId + ":" + result.id,
        outcome: result.outcome,
      });
    }
    if (connection.sending > 0 && state.status === "idle") return;
    if (state.status === "unknown") return;
    const previous = slot.runState;
    if (slot.conflict) {
      slot.runState = "conflict";
    } else if (state.status !== "idle") {
      slot.runState = "running";
    } else if (
      state.outcome === "failed" ||
      state.taskRuns?.settled.at(-1)?.outcome === "failed"
    ) {
      slot.runState = "failed";
    } else if (state.taskRuns?.settled.at(-1)?.outcome === "aborted") {
      slot.runState = "aborted";
    } else {
      slot.runState = "idle";
    }
    if (
      !force &&
      !changed &&
      previous === slot.runState &&
      !(newResults.length && state.status !== "idle")
    )
      return;
    if (state.status === "idle") {
      if (isBusyRunState(previous))
        slot.attention = slot.runState === "failed" ? "failed" : null;
      this.host.emit(slot, {
        type: "agent_settled",
        taskOutcomeReported: Boolean(sameReceiver),
        outcomeUnknown: !sameReceiver && state.outcome !== "failed",
      });
    } else {
      this.host.emit(slot, { type: "agent_start" });
    }
  }

  private schedule(slot: RuntimeSlot, connection: Connection): void {
    if (this.closed || this.connections.get(slot) !== connection) return;
    connection.timer = setTimeout(
      () => void this.poll(slot, connection),
      this.pollMs,
    );
    connection.timer.unref?.();
  }

  private async poll(slot: RuntimeSlot, connection: Connection): Promise<void> {
    const selectionRevision = connection.selectionRevision;
    try {
      const state = await connection.native.read();
      if (this.closed || this.connections.get(slot) !== connection) return;
      if (!this.host.current(slot)) {
        this.detach(slot);
        return;
      }
      // Load saved appends before deciding whether the reported leaf diverged.
      // A just-written continuation is not yet in the cached tree.
      if (
        !("ended" in state) &&
        state.leafId &&
        slot.projection &&
        !slot.projection.entry(state.leafId)
      )
        await this.host.reconcile(slot, false);
      if (this.closed || this.connections.get(slot) !== connection) return;
      // The attached Pi moving to another branch or session ends the binding;
      // the view keeps its own position.
      if ("ended" in state) {
        this.end(slot, state.ended);
        return;
      }
      if (!this.host.corresponds(slot, state.leafId ?? null)) {
        this.end(slot, "left-branch");
        return;
      }
      this.applyState(slot, connection, state, false, selectionRevision);
      // Background history may be intentionally reclaimed. Keep observing Pi
      // without rebuilding it; retained projections use their version fast path.
      if (slot.projection) await this.host.reconcile(slot, false);
      connection.failing = false;
    } catch (error) {
      if (!connection.failing && this.connections.get(slot) === connection)
        this.host.log(slot, error);
      connection.failing = true;
    } finally {
      this.schedule(slot, connection);
    }
  }

  /** Stops following the attached Pi. Inspire never learns how a task the
   * Pi was running turns out, so a busy view settles with no outcome claimed;
   * the event's reason says what was actually observed. */
  private end(slot: RuntimeSlot, reason: AttachmentEnd, release = true): void {
    const duringWork = isBusyRunState(slot.runState);
    this.detach(slot);
    if (slot.runState !== "failed")
      slot.runState = slot.conflict ? "conflict" : "idle";
    this.host.emit(slot, {
      type: "external_attachment_ended",
      reason,
      duringWork,
    });
    if (!release) return;
    this.host.emit(slot, { type: "runtime_ready" });
    this.host.released(slot);
  }

  async prompt(
    slot: RuntimeSlot,
    request: PromptRequest,
    epoch = slot.inputStopEpoch,
  ): Promise<ComposerHistoryEntry | null> {
    const connection = this.connections.get(slot);
    if (!connection)
      throw requestError("The external Pi connection has ended.", 409);
    if (slot.readOnlyReason === "workspace-unavailable")
      throw requestError(
        "This session is read-only because its project folder is unavailable",
        409,
        { code: "SESSION_WORKSPACE_UNAVAILABLE" },
      );
    const message = request.message.trim();
    if (message.length > MAX_PROMPT_CHARS)
      throw requestError("Message is too long", 413);
    if (
      (message.startsWith("/") || message.startsWith("!")) &&
      (request.attachmentIds?.length ||
        request.projectFiles?.length ||
        request.historyArtifacts)
    )
      throw requestError(
        "Pi commands cannot include attachments or project-file references",
        409,
      );
    const prepared = await this.attachments.resolveForPrompt(
      request.attachmentIds,
    );
    const copied: string[] = [];
    let delivered = false;
    try {
      const history = await resolveComposerHistoryArtifacts(
        slot,
        request,
        this.attachments,
      );
      const selected = await resolveProjectFiles(
        slot.cwd,
        request.projectFiles,
      );
      const expected = [...new Set([...selected, ...history.projectFiles])];
      const projectFiles = await revalidateProjectFiles(
        slot.cwd,
        [...(request.projectFiles ?? []), ...history.projectFiles],
        expected,
      );
      assertPromptArtifactBudget(
        prepared.files.length + history.files.length + history.images.length,
        prepared.files
          .filter((file) => file.kind === "file")
          .reduce((size, file) => size + file.size, 0) + history.fileBytes,
        [...prepared.images, ...history.images],
      );
      // Recalled images need managed files for the native receiver. Uploaded
      // images already have leased copies; neither becomes a text reference.
      const stagedImages = await this.attachments.stageImages(history.images);
      copied.push(...stagedImages.map((image) => image.id));
      const recovered = await this.attachments.resolveForPrompt(copied);
      const files = [...prepared.files, ...history.files].filter(
        (file) => file.kind === "file",
      );
      const images = [...prepared.files, ...recovered.files]
        .filter((file) => file.kind === "image")
        .map(({ path, mimeType }) => ({ path, mimeType }));
      const fullMessage = addAttachmentContext(message, files, projectFiles);
      if (!fullMessage && images.length === 0)
        throw requestError("Message or attachment is required", 400);
      const beforeSend = () => {
        if (
          this.connections.get(slot) !== connection ||
          !this.host.current(slot) ||
          slot.stoppingInput ||
          epoch !== slot.inputStopEpoch
        )
          throw requestError(
            "This input was stopped or the session changed before delivery.",
            409,
          );
        this.host.assertUsable(slot);
      };
      await this.host.reconcile(slot, true);
      beforeSend();
      const previous = slot.runState;
      connection.sending += 1;
      if (!isBusyRunState(slot.runState)) slot.runState = "queued";
      this.host.emit(slot, { type: "prompt_pending" });
      try {
        await connection.native.prompt(
          fullMessage,
          request.behavior,
          beforeSend,
          images.length ? images : undefined,
          connection.state.leafId,
        );
        delivered = true;
        if (this.connections.get(slot) === connection) {
          await this.host
            .reconcile(slot, false)
            .catch((error) => this.host.log(slot, error));
        }
      } catch (error) {
        delivered = Boolean(
          (error as { outcomeUnknown?: boolean })?.outcomeUnknown,
        );
        if (
          this.connections.get(slot) === connection &&
          slot.runState === "queued"
        ) {
          slot.runState = previous;
          this.host.emit(slot, { type: "prompt_finished" });
        }
        throw error;
      } finally {
        connection.sending -= 1;
      }
      return null;
    } finally {
      const ids = [...(request.attachmentIds ?? []), ...copied];
      if (delivered) {
        await this.attachments.releaseConsumed(ids);
      } else {
        this.attachments.restage(ids);
        await Promise.allSettled(
          copied.map((id) => this.attachments.remove(id)),
        );
      }
    }
  }

  async rename(slot: RuntimeSlot, name: string): Promise<void> {
    const connection = this.connections.get(slot);
    if (!connection)
      throw requestError("The external Pi connection has ended.", 409);
    await connection.native.rename(name, () => {
      if (this.connections.get(slot) !== connection || !this.host.current(slot))
        throw requestError("The external Pi connection has ended.", 409);
      this.host.assertUsable(slot);
    });
  }

  async abort(slot: RuntimeSlot): Promise<void> {
    const connection = this.connections.get(slot);
    if (!connection)
      throw requestError("The external Pi connection has ended.", 409);
    if (slot.stoppingInput)
      throw requestError("Stop is already in progress", 409);
    slot.inputStopEpoch += 1;
    slot.stoppingInput = true;
    try {
      await connection.native.abort(connection.state.leafId);
    } finally {
      slot.stoppingInput = false;
    }
  }

  detach(slot: RuntimeSlot, replacement?: ExternalSessionConnection): void {
    const connection = this.connections.get(slot);
    if (!connection) return;
    this.connections.delete(slot);
    this.host.syncUi?.(slot, [], connection.native);
    clearTimeout(connection.timer);
    if (connection.native !== replacement) connection.native.close();
  }

  close(): void {
    this.closed = true;
    for (const slot of this.connections.keys()) this.detach(slot);
  }
}
