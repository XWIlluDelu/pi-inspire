import {
  type ExtensionUiRequest,
  parsePendingExtensionUiRequest,
} from "../shared/contracts.js";
import {
  isPiRpcOutcomeUnknown,
  PiRpcOutcomeUnknownError,
  type PiRpcProcess,
} from "./pi-rpc.js";
import type { RuntimeSlot } from "./runtime-slot.js";

type ExtensionUiClearReason =
  | "settled"
  | "aborted"
  | "replaced"
  | "stopped"
  | "closed";

interface RuntimeExtensionUiHost {
  withMaintenance<T>(operation: () => Promise<T>): Promise<T>;
  slot(sessionId: string): RuntimeSlot | undefined;
  ownsSlot(sessionId: string, slot: RuntimeSlot): boolean;
  extensionResponseSlot<T>(
    slot: RuntimeSlot,
    operation: () => Promise<T>,
  ): Promise<T>;
  reconcileSlot(slot: RuntimeSlot, force?: boolean): Promise<unknown>;
  throwIfConflicted(slot: RuntimeSlot): void;
  processOwner(process: PiRpcProcess): RuntimeSlot | undefined;
  failUnknown(
    slot: RuntimeSlot,
    error: PiRpcOutcomeUnknownError,
  ): Promise<never>;
  emitSlotEvent(slot: RuntimeSlot, event: unknown): void;
  scheduleIdleWorkerEviction(): void;
}

/** Owns response-bearing Pi extension UI requests from admission through
 * expiry, worker rebinding, ordered response delivery, and removal. */
export class RuntimeExtensionUiController {
  constructor(private readonly host: RuntimeExtensionUiHost) {}

  pendingRequests(slot: RuntimeSlot): ExtensionUiRequest[] {
    return [...slot.pendingExtensionUiRequests.values()];
  }

  add(
    slot: RuntimeSlot,
    value: unknown,
    process: PiRpcProcess,
  ): ExtensionUiRequest | null {
    const request = parsePendingExtensionUiRequest(value);
    if (!request) return null;
    slot.pendingExtensionUiRequests.set(request.id, request);
    slot.pendingExtensionUiOwners.set(request.id, process);
    this.scheduleExpiry(slot, request);
    return request;
  }

  rebind(
    source: RuntimeSlot,
    destination: RuntimeSlot,
    process: PiRpcProcess,
  ): void {
    for (const timer of source.pendingExtensionUiTimers.values())
      clearTimeout(timer);
    source.pendingExtensionUiTimers.clear();
    for (const [id, request] of source.pendingExtensionUiRequests) {
      if (source.pendingExtensionUiOwners.get(id) !== process) continue;
      const rebound = {
        ...request,
        sessionId: destination.id,
      } as ExtensionUiRequest;
      destination.pendingExtensionUiRequests.set(id, rebound);
      destination.pendingExtensionUiOwners.set(id, process);
      this.scheduleExpiry(destination, rebound);
    }
    source.pendingExtensionUiRequests.clear();
    source.pendingExtensionUiOwners.clear();
  }

  clear(slot: RuntimeSlot, reason: ExtensionUiClearReason): void {
    if (
      slot.pendingExtensionUiRequests.size === 0 &&
      slot.pendingExtensionUiOwners.size === 0 &&
      slot.pendingExtensionUiTimers.size === 0
    )
      return;
    for (const timer of slot.pendingExtensionUiTimers.values())
      clearTimeout(timer);
    slot.pendingExtensionUiTimers.clear();
    slot.pendingExtensionUiRequests.clear();
    slot.pendingExtensionUiOwners.clear();
    this.host.emitSlotEvent(slot, { type: "extension_ui_clear", reason });
    this.host.scheduleIdleWorkerEviction();
  }

  respond(response: Record<string, unknown>): Promise<void> {
    return this.host.withMaintenance(() => this.respondInside(response));
  }

  private remove(
    slot: RuntimeSlot,
    id: string,
    reason: "answered" | "expired" | "cleared",
  ): boolean {
    if (!slot.pendingExtensionUiRequests.delete(id)) return false;
    slot.pendingExtensionUiOwners.delete(id);
    const timer = slot.pendingExtensionUiTimers.get(id);
    if (timer) clearTimeout(timer);
    slot.pendingExtensionUiTimers.delete(id);
    this.host.emitSlotEvent(slot, { type: "extension_ui_remove", id, reason });
    this.host.scheduleIdleWorkerEviction();
    return true;
  }

  private scheduleExpiry(slot: RuntimeSlot, request: ExtensionUiRequest): void {
    const previousTimer = slot.pendingExtensionUiTimers.get(request.id);
    if (previousTimer) clearTimeout(previousTimer);
    slot.pendingExtensionUiTimers.delete(request.id);
    if (request.expiresAt === undefined) return;
    const delay = Math.max(0, request.expiresAt - Date.now());
    const timer = setTimeout(() => {
      if (
        slot.pendingExtensionUiRequests.get(request.id)?.expiresAt !==
        request.expiresAt
      )
        return;
      this.remove(slot, request.id, "expired");
    }, delay);
    timer.unref?.();
    slot.pendingExtensionUiTimers.set(request.id, timer);
  }

  private async respondInside(
    response: Record<string, unknown>,
  ): Promise<void> {
    const sessionId =
      typeof response.sessionId === "string" ? response.sessionId : "";
    const requestId = typeof response.id === "string" ? response.id : "";
    const slot = this.host.slot(sessionId);
    if (!slot)
      throw Object.assign(
        new Error("The extension request no longer has a live Pi runtime"),
        { status: 409 },
      );
    const { sessionId: _owner, ...wireResponse } = response;
    await this.host.extensionResponseSlot(slot, async () => {
      if (
        !this.host.ownsSlot(sessionId, slot) ||
        slot.conflict ||
        slot.projection?.health.status === "error"
      ) {
        throw Object.assign(
          new Error(
            slot.conflict?.message ??
              slot.projection?.health.message ??
              "The extension request owner changed",
          ),
          { status: 409 },
        );
      }
      await this.host.reconcileSlot(slot, true);
      if (!this.host.ownsSlot(sessionId, slot))
        throw Object.assign(new Error("The extension request owner changed"), {
          status: 409,
        });
      this.host.throwIfConflicted(slot);
      const request = slot.pendingExtensionUiRequests.get(requestId);
      const process = slot.pendingExtensionUiOwners.get(requestId);
      if (!request || !process)
        throw Object.assign(
          new Error("The extension request is no longer pending"),
          { status: 409 },
        );
      if (
        request.sessionId !== sessionId ||
        slot.process !== process ||
        !slot.ready ||
        this.host.processOwner(process) !== slot
      ) {
        throw Object.assign(
          new Error("The extension request no longer belongs to this worker"),
          { status: 409 },
        );
      }
      if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) {
        this.remove(slot, requestId, "expired");
        throw Object.assign(
          new Error("The extension request expired before the response"),
          { status: 409 },
        );
      }
      try {
        await process.sendExtensionUiResponse(wireResponse);
        this.remove(slot, requestId, "answered");
        // stdin order makes the correlated read a consumption fence.
        await process.request({ type: "get_state" });
      } catch (error) {
        const unknown = new PiRpcOutcomeUnknownError(
          "extension_ui_response",
          "Pi extension response outcome is unknown because its delivery fence failed",
        );
        if (isPiRpcOutcomeUnknown(error)) unknown.stopped = error.stopped;
        await this.host.failUnknown(slot, unknown);
      }
    });
  }
}
