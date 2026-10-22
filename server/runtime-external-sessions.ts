import type {
  NativeModelCatalog,
  NativeModelSelection,
} from "../docs/examples/session-activity.js";
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
  interrupted: boolean;
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

  supportsModels(slot: RuntimeSlot): boolean {
    const c = this.connections.get(slot);
    return (
      c?.state.modelControls === true &&
      Boolean(c.native.models && c.native.setModel && c.native.setThinkingLevel)
    );
  }

  modelSelection(slot: RuntimeSlot): NativeModelSelection | undefined {
    return this.connections.get(slot)?.state.modelSelection;
  }

  async models(slot: RuntimeSlot): Promise<NativeModelCatalog> {
    const c = this.modelConnection(slot);
    if (c.modelRefresh) return c.modelRefresh;
    const selectionRevision = c.selectionRevision;
    const pending = c.native.models!().then((result) => {
      // Catalog reads run alongside setters. A delayed read can still supply
      // models, but cannot undo a selection completed/observed since it began.
      const current =
        c.selectionRevision === selectionRevision
          ? result
          : { ...result, ...c.state.modelSelection };
      this.applyModelState(slot, c, current);
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
    if (!c || c.interrupted)
      throw requestError(
        "The original Pi connection is unavailable. Reopen this session to check its owner.",
        409,
        { code: "SESSION_OWNER_UNAVAILABLE" },
      );
    if (!this.supportsModels(slot))
      throw requestError(
        "Load the updated session-activity extension with /reload in the original Pi terminal, then reselect this session.",
        409,
        { code: "NATIVE_ACTIONS_UNAVAILABLE" },
      );
    this.host.assertUsable(slot);
    return c;
  }

  private applyModelState(
    slot: RuntimeSlot,
    c: Connection,
    state: NativeModelSelection | NativeModelCatalog,
  ): void {
    if (this.connections.get(slot) !== c || !this.host.current(slot))
      throw requestError("The external Pi connection has ended.", 409);
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
      native.setModel!(provider, modelId, beforeSend),
    );
  }

  async setThinkingLevel(
    slot: RuntimeSlot,
    level: NativeModelSelection["thinkingLevel"],
  ): Promise<NativeModelSelection> {
    return this.changeSelection(slot, (native, beforeSend) =>
      native.setThinkingLevel!(level, beforeSend),
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
    const result = await change(c.native, () => {
      if (this.connections.get(slot) !== c)
        throw requestError("The external Pi connection has ended.", 409);
      this.host.assertUsable(slot);
    });
    this.applyModelState(slot, c, result);
    await this.host.reconcile(slot, false);
    return { model: result.model, thinkingLevel: result.thinkingLevel };
  }

  needsInput(slot: RuntimeSlot): boolean {
    return this.connections.get(slot)?.state.status === "blocked";
  }

  async connect(slot: RuntimeSlot): Promise<boolean> {
    const pending = this.connecting.get(slot);
    if (pending) return pending;
    const operation = this.connectInside(slot);
    this.connecting.set(slot, operation);
    try {
      return await operation;
    } finally {
      if (this.connecting.get(slot) === operation) this.connecting.delete(slot);
    }
  }

  private async connectInside(slot: RuntimeSlot): Promise<boolean> {
    if (this.closed || slot.process || !slot.sessionPath) return false;
    const previous = this.connections.get(slot);
    if (previous) {
      try {
        const state = await previous.native.read();
        if (this.closed || !this.host.current(slot) || slot.process)
          return false;
        if (state) {
          previous.interrupted = false;
          this.setUnavailable(slot, false);
          this.applyState(slot, previous, state);
          return true;
        }
        this.detach(slot);
      } catch {
        previous.interrupted = true;
        this.setUnavailable(slot, true);
      }
    }
    const ownerUnavailable = () =>
      requestError(
        "The original Pi connection is unavailable. Its ownership has not been released.",
        409,
        { code: "SESSION_OWNER_UNAVAILABLE" },
      );
    const native = await this.connector(slot.id, slot.sessionPath);
    if (native === null) {
      if (this.connections.has(slot)) throw ownerUnavailable();
      return false;
    }
    if (this.closed || !this.host.current(slot) || slot.process) {
      native.close();
      return false;
    }
    let state: ExternalSessionState | null;
    try {
      state = await native.read();
    } catch (error) {
      if (this.closed || !this.host.current(slot) || slot.process) {
        native.close();
        throw error;
      }
      // Retain the identified owner even if its endpoint cannot be observed.
      // Losing a connection is not permission to start another writer.
      this.detach(slot, native);
      const connection: Connection = {
        native,
        state: { status: "unknown" },
        interrupted: true,
        sending: 0,
        selectionRevision: 0,
      };
      this.connections.set(slot, connection);
      this.setUnavailable(slot, true);
      this.schedule(slot, connection);
      throw error;
    }
    if (!state || this.closed || !this.host.current(slot) || slot.process) {
      native.close();
      if (this.connections.has(slot)) throw ownerUnavailable();
      return false;
    }
    const connection: Connection = {
      native,
      state,
      interrupted: false,
      sending: 0,
      selectionRevision: 0,
    };
    this.detach(slot, native);
    this.connections.set(slot, connection);
    this.setUnavailable(slot, false);
    this.applyState(slot, connection, state, true);
    this.schedule(slot, connection);
    this.host.emit(slot, { type: "runtime_ready" });
    return true;
  }

  private setUnavailable(slot: RuntimeSlot, unavailable: boolean): void {
    if (slot.readOnlyReason === "workspace-unavailable") return;
    const reason = unavailable ? "external-unavailable" : null;
    if (slot.readOnlyReason === reason) return;
    slot.readOnlyReason = reason;
    this.host.emit(slot, { type: "runtime_ready" });
  }

  private applyState(
    slot: RuntimeSlot,
    connection: Connection,
    state: ExternalSessionState,
    force = false,
  ): void {
    const priorState = connection.state;
    const changed = priorState.status !== state.status;
    const selectionChanged =
      JSON.stringify(priorState.modelSelection) !==
      JSON.stringify(state.modelSelection);
    connection.state = state;
    if (selectionChanged) connection.selectionRevision++;
    if (priorState.modelControls !== state.modelControls || selectionChanged) {
      this.host.emit(slot, { type: "model_metadata_changed" });
    }
    if (force || priorState.taskRuns?.receiverId !== state.taskRuns?.receiverId)
      slot.availableModels = null;
    const sameReceiver =
      !force &&
      state.taskRuns &&
      priorState.taskRuns?.receiverId === state.taskRuns.receiverId;
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
        outcomeId: state.taskRuns!.receiverId + ":" + result.id,
        outcome: result.outcome,
      });
    }
    if (connection.sending > 0 && state.status === "idle") return;
    if (state.status === "unknown") return;
    const previous = slot.runState;
    slot.runState = slot.conflict
      ? "conflict"
      : state.status === "idle"
        ? state.outcome === "failed" ||
          state.taskRuns?.settled.at(-1)?.outcome === "failed"
          ? "failed"
          : state.taskRuns?.settled.at(-1)?.outcome === "aborted"
            ? "aborted"
            : "idle"
        : "running";
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
    try {
      const state = await connection.native.read().catch((error) => {
        if (this.connections.get(slot) === connection)
          this.setUnavailable(slot, true);
        throw error;
      });
      if (this.closed || this.connections.get(slot) !== connection) return;
      if (!this.host.current(slot)) {
        this.detach(slot);
        return;
      }
      if (!state) {
        if (
          connection.native.retirementReason === "process-exit" &&
          isBusyRunState(slot.runState)
        ) {
          slot.runState = "failed";
          this.host.emit(slot, {
            type: "runtime_error",
            error: "The native Pi process exited during work.",
          });
        }
        this.detach(slot);
        this.setUnavailable(slot, true);
        if (slot.runState !== "failed")
          slot.runState = slot.conflict ? "conflict" : "idle";
        this.host.emit(slot, { type: "runtime_ready" });
        return;
      }
      this.setUnavailable(slot, false);
      this.applyState(slot, connection, state);
      // Background history may be intentionally reclaimed. Keep observing Pi
      // without rebuilding it; retained projections use their version fast path.
      if (slot.projection) await this.host.reconcile(slot, false);
      connection.interrupted = false;
    } catch (error) {
      if (!connection.interrupted && this.connections.get(slot) === connection)
        this.host.log(slot, error);
      connection.interrupted = true;
    } finally {
      this.schedule(slot, connection);
    }
  }

  async prompt(
    slot: RuntimeSlot,
    request: PromptRequest,
    epoch = slot.inputStopEpoch,
  ): Promise<ComposerHistoryEntry | null> {
    const connection = this.connections.get(slot);
    if (!connection)
      throw requestError("The external Pi connection has ended.", 409);
    if (slot.readOnlyReason)
      throw requestError(
        "The external Pi connection is unavailable. Reopen this session to check its connection.",
        409,
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
    let references: string[] = [];
    let releaseReferences: (() => void) | undefined;
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
      references = [
        ...history.files.map((file) => file.path),
        ...this.attachments.referencedPromptFiles(message),
      ];
      releaseReferences = this.attachments.leasePromptFiles(references);
      if (slot.sessionPath)
        await this.attachments.registerSession(slot.sessionPath);
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
        await this.attachments.releaseConsumed(ids, slot.sessionPath);
        this.attachments.retainPromptFiles(references, slot.sessionPath);
      } else {
        this.attachments.restage(ids);
        await Promise.allSettled(
          copied.map((id) => this.attachments.remove(id)),
        );
      }
      releaseReferences?.();
    }
  }

  async rename(slot: RuntimeSlot, name: string): Promise<void> {
    const connection = this.connections.get(slot);
    if (!connection)
      throw requestError("The external Pi connection has ended.", 409);
    if (!connection.native.rename)
      throw requestError("Rename this Pi in its original terminal.", 409);
    await connection.native.rename(name, () => {
      if (this.connections.get(slot) !== connection || !this.host.current(slot))
        throw requestError("The external Pi connection has ended.", 409);
      this.host.assertUsable(slot);
    });
  }

  async abort(slot: RuntimeSlot): Promise<"agent" | undefined> {
    const connection = this.connections.get(slot);
    if (!connection)
      throw requestError("The external Pi connection has ended.", 409);
    if (slot.stoppingInput)
      throw requestError("Stop is already in progress", 409);
    slot.inputStopEpoch += 1;
    slot.stoppingInput = true;
    try {
      await connection.native.abort();
      return connection.native.interruptionScope;
    } finally {
      slot.stoppingInput = false;
    }
  }

  detach(slot: RuntimeSlot, replacement?: ExternalSessionConnection): void {
    const connection = this.connections.get(slot);
    if (!connection) return;
    this.connections.delete(slot);
    clearTimeout(connection.timer);
    if (connection.native !== replacement) connection.native.close();
  }

  close(): void {
    this.closed = true;
    for (const slot of this.connections.keys()) this.detach(slot);
  }
}
