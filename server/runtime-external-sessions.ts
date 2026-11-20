import type {
  ModelCatalog as NativeModelCatalog,
  ModelSelection as NativeModelSelection,
} from "../extensions/attach-control.js";
import { parseCommandInvocation } from "../shared/commands.js";
import {
  isBusyRunState,
  MAX_PROMPT_CHARS,
  type PromptRequest,
} from "../shared/contracts.js";
import type { TaskOutcome } from "../shared/notifications.js";
import type { AttachmentStore } from "./attachments.js";
import {
  type AttachmentEnd,
  type ConnectExternalSession,
  type ExternalSessionConnection,
  type ExternalSessionRead,
  type ExternalSessionState,
  PI_STATE_OBSERVATION_TIMEOUT_MS,
} from "./external-session.js";
import { requestError } from "./request-error.js";
import {
  preparePiPrompt,
  stagePromptInput,
} from "./runtime-composer-artifacts.js";
import type { RuntimeSlot } from "./runtime-slot.js";

interface Connection {
  native: ExternalSessionConnection;
  state: ExternalSessionState;
  timer?: ReturnType<typeof setTimeout>;
  /** The last read failed; logged once per failure run. */
  failing: boolean;
  sending: number;
  latestRead: number;
  selectionRevision: number;
  modelRefresh?: Promise<NativeModelCatalog>;
}

interface ExternalSessionHost {
  current(slot: RuntimeSlot): boolean;
  emit(slot: RuntimeSlot, event: unknown): void;
  taskOutcome(slot: RuntimeSlot, outcome: TaskOutcome, id?: string): void;
  reconcile(slot: RuntimeSlot, force: boolean): Promise<unknown>;
  assertUsable(slot: RuntimeSlot): void;
  log(slot: RuntimeSlot, error: unknown): void;
  released(slot: RuntimeSlot): void;
  followLeaf(slot: RuntimeSlot, leafId: string | null): void;
  renewView(slot: RuntimeSlot): void;
  /** Whether a leaf still continues this view's branch. */
  corresponds(slot: RuntimeSlot, leafId: string | null): boolean;
  /** A confirmed leaf at or after the selected position. */
  continues(slot: RuntimeSlot, leafId: string | null): boolean;
}

/** Conversation access to externally owned sessions, deliberately outside the
 * owned-worker pool, RPC persistence attestations and process retirement. */
export class RuntimeExternalSessions {
  private readonly connections = new Map<RuntimeSlot, Connection>();
  private readonly connecting = new Map<RuntimeSlot, Promise<boolean>>();
  private readSequence = 0;
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

  canQueue(slot: RuntimeSlot): boolean {
    return this.connections.get(slot)?.state.queueAdmission === true;
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
    const instanceId = c.state.taskRuns.instanceId;
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

  private assertModelReceiver(
    slot: RuntimeSlot,
    connection: Connection,
    instanceId: string,
  ): void {
    if (this.connections.get(slot) !== connection || !this.host.current(slot))
      throw requestError("The external Pi connection has ended.", 409);
    if (connection.state.taskRuns.instanceId !== instanceId)
      throw requestError("The native Pi model receiver changed.", 409);
  }

  private applyModelState(
    slot: RuntimeSlot,
    c: Connection,
    state: NativeModelSelection | NativeModelCatalog,
    instanceId: string,
  ): void {
    this.assertModelReceiver(slot, c, instanceId);
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
    const instanceId = c.state.taskRuns.instanceId;
    const result = await change(c.native, () => {
      this.assertModelReceiver(slot, c, instanceId);
      this.host.assertUsable(slot);
    });
    this.applyModelState(slot, c, result, instanceId);
    await this.host.reconcile(slot, false);
    return { model: result.model, thinkingLevel: result.thinkingLevel };
  }

  needsInput(slot: RuntimeSlot): boolean {
    return this.connections.get(slot)?.state.activity === "blocked";
  }

  async connect(slot: RuntimeSlot, idleOnly = false): Promise<boolean> {
    const pending = this.connecting.get(slot);
    if (pending) return pending;
    const operation = this.connectInside(slot, idleOnly);
    this.connecting.set(slot, operation);
    try {
      return await operation;
    } finally {
      this.connecting.delete(slot);
    }
  }

  private async connectInside(
    slot: RuntimeSlot,
    idleOnly: boolean,
  ): Promise<boolean> {
    if (this.closed || slot.process || !slot.sessionPath) return false;
    const previous = this.connections.get(slot);
    if (previous) {
      if (await this.refreshConnection(slot, previous, "reconnect"))
        return true;
      if (this.closed || !this.host.current(slot) || slot.process) return false;
    }
    const native = await this.connector(
      slot.id,
      slot.sessionPath,
      (leaf) => {
        if (this.host.continues(slot, leaf)) return "continues";
        if (
          this.host.corresponds(slot, leaf) ||
          (leaf !== null && !slot.projection?.entry(leaf))
        )
          return "possible";
        return "other";
      },
      idleOnly,
    );
    if (!native || this.closed || !this.host.current(slot) || slot.process)
      return false;
    const state = await native.read(
      idleOnly ? PI_STATE_OBSERVATION_TIMEOUT_MS : undefined,
    );
    await this.reconcileReportedLeaf(slot, state);
    if (
      "ended" in state ||
      (idleOnly && state.activity !== "idle") ||
      !this.host.continues(slot, state.leafId) ||
      this.closed ||
      !this.host.current(slot) ||
      slot.process
    )
      return false;
    const connection: Connection = {
      native,
      state,
      failing: false,
      sending: 0,
      latestRead: 0,
      selectionRevision: 0,
    };
    this.connections.set(slot, connection);
    this.host.renewView(slot);
    // Attached Pi accepts input: the view is no longer read-only.
    if (slot.readOnlyReason === "external-active") slot.readOnlyReason = null;
    this.applyState(slot, connection, state, true);
    this.schedule(slot, connection);
    this.host.emit(slot, { type: "runtime_ready" });
    return true;
  }

  private async reconcileReportedLeaf(
    slot: RuntimeSlot,
    state: ExternalSessionRead,
  ): Promise<void> {
    if (
      !("ended" in state) &&
      state.leafId &&
      slot.projection &&
      !slot.projection.entry(state.leafId)
    )
      await this.host.reconcile(slot, false);
  }

  private async refreshConnection(
    slot: RuntimeSlot,
    connection: Connection,
    mode: "read" | "background" | "reconnect" | "restart" = "read",
    read = ++this.readSequence,
  ): Promise<boolean> {
    const selectionRevision = connection.selectionRevision;
    let state: ExternalSessionRead | undefined;
    try {
      state = await connection.native.read();
    } catch (error) {
      if (mode === "background" || mode === "restart") throw error;
      // A transient failure keeps the attachment; its poll continues.
    }
    if (mode === "background") {
      if (this.closed || this.connections.get(slot) !== connection)
        return false;
      if (!this.host.current(slot)) {
        this.detach(slot);
        return false;
      }
    }
    if (state) await this.reconcileReportedLeaf(slot, state);
    if (
      this.closed ||
      !this.host.current(slot) ||
      slot.process ||
      this.connections.get(slot) !== connection
    )
      return false;
    if (!state || read < connection.latestRead) return true;
    if (mode === "restart" && "ended" in state && state.ended === "unreachable")
      throw requestError("The attached Pi could not confirm its state.", 409);
    connection.latestRead = read;
    if ("ended" in state || !this.host.corresponds(slot, state.leafId)) {
      this.end(
        slot,
        "ended" in state ? state.ended : "left-branch",
        mode !== "reconnect",
      );
      return false;
    }
    this.applyState(slot, connection, state, false, selectionRevision);
    // Background history may be reclaimed without interrupting the native poll.
    if (mode === "background" && slot.projection)
      await this.host.reconcile(slot, false);
    connection.failing = false;
    return true;
  }

  /** Revalidate the current receiver without attaching or starting another Pi. */
  async withAttachment<T>(
    slot: RuntimeSlot,
    operation: () => Promise<T>,
  ): Promise<T> {
    const connection = this.connections.get(slot);
    if (
      !connection ||
      !(await this.refreshConnection(slot, connection)) ||
      this.connections.get(slot) !== connection
    )
      throw requestError("The external Pi connection has ended.", 409);
    return operation();
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
    const changed =
      priorState.activity !== state.activity ||
      priorState.queueAdmission !== state.queueAdmission;
    const selectionChanged =
      JSON.stringify(priorState.modelSelection) !==
      JSON.stringify(state.modelSelection);
    const receiverChanged =
      priorState.taskRuns.instanceId !== state.taskRuns.instanceId;
    connection.state = state;
    this.host.followLeaf(slot, state.leafId);
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
    const sameReceiver = !force && !receiverChanged;
    const oldResults = new Set(
      priorState.taskRuns.settled.map((item) => item.id),
    );
    const newResults = sameReceiver
      ? state.taskRuns.settled.filter(
          (item) =>
            !oldResults.has(item.id) &&
            item.settledAt > Date.now() - 15 * 60_000,
        )
      : [];
    for (const result of newResults) {
      if (result.outcome !== "aborted")
        this.host.taskOutcome(
          slot,
          result.outcome,
          state.taskRuns.instanceId + ":" + result.id,
        );
    }
    if (connection.sending > 0 && state.activity === "idle") return;
    const previous = slot.runState;
    if (slot.conflict) {
      slot.runState = "conflict";
    } else if (state.activity !== "idle") {
      slot.runState = "running";
    } else {
      const outcome = state.taskRuns.settled.at(-1)?.outcome;
      slot.runState =
        outcome === "failed" || outcome === "aborted" ? outcome : "idle";
    }
    if (
      !force &&
      !changed &&
      previous === slot.runState &&
      !(newResults.length && state.activity !== "idle")
    )
      return;
    if (state.activity === "idle") {
      if (isBusyRunState(previous)) {
        slot.attention = slot.runState === "failed" ? "failed" : null;
        if (!sameReceiver) this.host.taskOutcome(slot, "ended");
      }
      this.host.emit(slot, {
        type: "agent_settled",
        completed: newResults.at(-1)?.outcome === "completed",
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
    connection.timer.unref();
  }

  private async poll(slot: RuntimeSlot, connection: Connection): Promise<void> {
    const read = ++this.readSequence;
    try {
      await this.refreshConnection(slot, connection, "background", read);
    } catch (error) {
      if (
        this.connections.get(slot) !== connection ||
        read < connection.latestRead
      )
        return;
      if (!connection.failing) this.host.log(slot, error);
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
    if (duringWork && reason === "exited") this.host.taskOutcome(slot, "ended");
    this.detach(slot);
    this.host.renewView(slot);
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

  bindPrompt(slot: RuntimeSlot) {
    const connection = this.connections.get(slot);
    if (!connection) return undefined;
    return (request: PromptRequest, epoch: number, assertView: () => void) =>
      this.prompt(slot, connection, request, epoch, assertView);
  }

  private async prompt(
    slot: RuntimeSlot,
    connection: Connection,
    request: PromptRequest,
    epoch: number,
    assertView: () => void,
  ): Promise<void> {
    if (this.connections.get(slot) !== connection)
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
    const command = parseCommandInvocation(message);
    if (message.startsWith("!") || command)
      throw requestError(
        command
          ? `/${command.name} is unavailable while this session is attached to another Pi.`
          : "Shell commands are unavailable while this session is attached to another Pi.",
        409,
        { code: "NATIVE_ACTION_UNSUPPORTED" },
      );
    assertView();
    if (!(await this.refreshConnection(slot, connection)))
      throw requestError("The external Pi connection has ended.", 409);
    assertView();
    if (
      connection.state.activity === "working" &&
      connection.state.queueAdmission !== true
    )
      throw requestError(
        "Queue input in the original Pi terminal. This connection cannot confirm Steer or Follow up.",
        409,
        { code: "ATTACH_CONTROL_QUEUE_ACK_UNAVAILABLE" },
      );
    const originalIds = request.attachmentIds ?? [];
    const input = await stagePromptInput(slot, request, this.attachments);
    const copied: string[] = [];
    let delivered = false;
    let uncertain = false;
    try {
      const { fullMessage, images } = await preparePiPrompt(
        slot,
        request,
        message,
        input,
        this.attachments,
      );
      // The receiver may outlive a lost receipt. Its copies have a separate
      // lifetime from the editor's original upload handles.
      const transportImages =
        await this.attachments.prepareTransportImages(images);
      copied.push(...transportImages.map((image) => image.id));
      const beforeSend = () => {
        assertView();
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
          transportImages.length
            ? transportImages.map(({ path, mimeType }) => ({ path, mimeType }))
            : undefined,
          connection.state.leafId,
        );
        delivered = true;
        if (this.connections.get(slot) === connection) {
          await this.host
            .reconcile(slot, false)
            .catch((error) => this.host.log(slot, error));
        }
      } catch (error) {
        uncertain = Boolean(
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
    } finally {
      if (uncertain) {
        this.attachments.restageUncertainPrompt(originalIds, copied);
      } else if (delivered) {
        await this.attachments
          .releaseConsumed([...originalIds, ...copied])
          .catch((error) => this.host.log(slot, error));
      } else {
        this.attachments.restage([...originalIds, ...copied]);
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

  async abort(slot: RuntimeSlot, forRestart = false): Promise<void> {
    const connection = this.connections.get(slot);
    if (!connection)
      throw requestError("The external Pi connection has ended.", 409);
    let leafId = connection.state.leafId;
    if (forRestart) {
      const attached = await this.refreshConnection(
        slot,
        connection,
        "restart",
      );
      if (!attached || connection.state.activity === "idle") return;
      leafId ??= connection.state.leafId;
    }
    if (slot.stoppingInput)
      throw requestError("Stop is already in progress", 409);
    slot.inputStopEpoch += 1;
    slot.stoppingInput = true;
    try {
      await connection.native.abort(leafId);
    } finally {
      slot.stoppingInput = false;
    }
  }

  detach(slot: RuntimeSlot): void {
    const connection = this.connections.get(slot);
    if (!connection) return;
    this.connections.delete(slot);
    clearTimeout(connection.timer);
  }

  close(): void {
    this.closed = true;
    for (const slot of this.connections.keys()) this.detach(slot);
  }
}
