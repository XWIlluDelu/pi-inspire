import {
  isBusyRunState,
  MAX_PROMPT_CHARS,
  type ComposerHistoryEntry,
  type PromptRequest,
} from "../shared/contracts.js";
import {
  addAttachmentContext,
  type AttachmentStore,
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
}

interface ExternalSessionHost {
  current(slot: RuntimeSlot): boolean;
  emit(slot: RuntimeSlot, event: unknown): void;
  reconcile(slot: RuntimeSlot): Promise<unknown>;
  assertUsable(slot: RuntimeSlot): void;
  log(slot: RuntimeSlot, error: unknown): void;
}

/** Conversation access to existing terminal sessions, deliberately outside the
 * owned-worker pool, RPC persistence attestations and process retirement. */
export class RuntimeExternalSessions {
  private readonly connections = new Map<RuntimeSlot, Connection>();
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

  needsInput(slot: RuntimeSlot): boolean {
    return this.connections.get(slot)?.state.status === "blocked";
  }

  async connect(slot: RuntimeSlot): Promise<boolean> {
    if (this.closed || slot.process || !slot.sessionPath) return false;
    if (this.connections.has(slot)) return true;
    const native = await this.connector(slot.id, slot.sessionPath);
    if (!native) return false;
    if (this.closed || !this.host.current(slot) || slot.process) {
      native.close();
      return false;
    }
    const state = await native.read().catch((error) => {
      native.close();
      throw error;
    });
    if (!state || this.closed || !this.host.current(slot) || slot.process) {
      native.close();
      return false;
    }
    const connection: Connection = {
      native,
      state,
      interrupted: false,
      sending: 0,
    };
    this.connections.set(slot, connection);
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
  ): void {
    const changed = connection.state.status !== state.status;
    connection.state = state;
    if (connection.sending > 0 && state.status === "idle") return;
    if (state.status === "unknown") return;
    const previous = slot.runState;
    slot.runState = slot.conflict
      ? "conflict"
      : state.status === "idle"
        ? "idle"
        : "running";
    if (!force && !changed && previous === slot.runState) return;
    if (state.status === "idle") {
      if (isBusyRunState(previous)) slot.attention = "completed";
      this.host.emit(slot, { type: "agent_settled" });
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
      const state = await connection.native.read();
      if (this.closed || this.connections.get(slot) !== connection) return;
      if (!this.host.current(slot)) {
        this.detach(slot);
        return;
      }
      if (!state) {
        this.detach(slot);
        slot.runState = slot.conflict ? "conflict" : "idle";
        this.host.emit(slot, { type: "runtime_ready" });
        return;
      }
      connection.interrupted = false;
      this.applyState(slot, connection, state);
      // SessionProjection watches native writes; polling also catches changes
      // on filesystems whose watch events are coalesced or unavailable.
      await this.host.reconcile(slot);
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
      throw requestError("The Pi terminal connection has ended.", 409);
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
      // Native Pi's interactive input represents dropped/pasted images by file
      // path. Keep the same file-backed input, including recovered images.
      const stagedImages = await this.attachments.stageImages(history.images);
      copied.push(...stagedImages.map((image) => image.id));
      const recovered = await this.attachments.resolveForPrompt(copied);
      const files = [
        ...prepared.files,
        ...history.files,
        ...recovered.files,
      ].map((file) => ({ kind: "file" as const, path: file.path }));
      const fullMessage = addAttachmentContext(message, files, projectFiles);
      if (!fullMessage)
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
      await this.host.reconcile(slot);
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
        );
        delivered = true;
        if (this.connections.get(slot) === connection) {
          await this.host
            .reconcile(slot)
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

  async command(slot: RuntimeSlot, text: string): Promise<void> {
    const connection = this.connections.get(slot);
    if (!connection)
      throw requestError("The Pi terminal connection has ended.", 409);
    await connection.native.prompt(text, undefined, () => {
      if (this.connections.get(slot) !== connection || !this.host.current(slot))
        throw requestError("The Pi terminal connection has ended.", 409);
      this.host.assertUsable(slot);
    });
  }

  async abort(slot: RuntimeSlot): Promise<void> {
    const connection = this.connections.get(slot);
    if (!connection)
      throw requestError("The Pi terminal connection has ended.", 409);
    if (slot.stoppingInput)
      throw requestError("Stop is already in progress", 409);
    slot.inputStopEpoch += 1;
    slot.stoppingInput = true;
    try {
      await connection.native.abort();
    } finally {
      slot.stoppingInput = false;
    }
  }

  detach(slot: RuntimeSlot): void {
    const connection = this.connections.get(slot);
    if (!connection) return;
    this.connections.delete(slot);
    clearTimeout(connection.timer);
    connection.native.close();
  }

  close(): void {
    this.closed = true;
    for (const slot of this.connections.keys()) this.detach(slot);
  }
}
