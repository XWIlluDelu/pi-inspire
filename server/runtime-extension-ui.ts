import {
  type ExtensionUiRequest,
  parsePendingExtensionUiRequest,
} from "../shared/contracts.js";
import {
  isPiRpcOutcomeUnknown,
  PiRpcOutcomeUnknownError,
  type PiRpcProcess,
} from "./pi-rpc.js";
import { requestError } from "./request-error.js";
import type { PendingExtensionDialog, RuntimeSlot } from "./runtime-slot.js";

type ExtensionUiClearReason = "aborted" | "replaced" | "stopped" | "closed";

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
  failUnknown(
    slot: RuntimeSlot,
    error: PiRpcOutcomeUnknownError,
  ): Promise<never>;
  emitSlotEvent(slot: RuntimeSlot, event: unknown): void;
  scheduleIdleWorkerEviction(): void;
}

/** Owns response-bearing Pi extension UI requests from admission through
 * expiry, ordered process-bound response delivery, and removal. */
export class RuntimeExtensionUiController {
  constructor(private readonly host: RuntimeExtensionUiHost) {}

  pendingRequests(slot: RuntimeSlot): ExtensionUiRequest[] {
    return Array.from(
      slot.pendingExtensionDialogs.values(),
      ({ request }) => request,
    );
  }

  add(
    slot: RuntimeSlot,
    value: unknown,
    process: PiRpcProcess,
  ): ExtensionUiRequest | null {
    const request = parsePendingExtensionUiRequest(value);
    if (!request) return null;
    clearTimeout(slot.pendingExtensionDialogs.get(request.id)?.timer);
    const dialog: PendingExtensionDialog = { request, process };
    slot.pendingExtensionDialogs.set(request.id, dialog);
    if (request.expiresAt !== undefined) {
      dialog.timer = setTimeout(
        () => this.remove(slot, dialog, "expired"),
        Math.max(0, request.expiresAt - Date.now()),
      );
      dialog.timer.unref();
    }
    return request;
  }

  clear(slot: RuntimeSlot, reason: ExtensionUiClearReason): void {
    if (slot.pendingExtensionDialogs.size === 0) return;
    for (const { timer } of slot.pendingExtensionDialogs.values())
      clearTimeout(timer);
    slot.pendingExtensionDialogs.clear();
    this.host.emitSlotEvent(slot, { type: "extension_ui_clear", reason });
    this.host.scheduleIdleWorkerEviction();
  }

  /** Cancel only this snapshot. A response can start another independent
   * question; that new request must remain answerable. */
  async cancel(slot: RuntimeSlot, process: PiRpcProcess): Promise<void> {
    for (const dialog of [...slot.pendingExtensionDialogs.values()]) {
      if (dialog.process === process)
        await this.respondInside(
          { sessionId: slot.id, id: dialog.request.id, cancelled: true },
          { slot, dialog },
        );
    }
  }

  respond(response: Record<string, unknown>): Promise<void> {
    return this.host.withMaintenance(() => this.respondInside(response));
  }

  private remove(
    slot: RuntimeSlot,
    dialog: PendingExtensionDialog,
    reason: "answered" | "expired",
  ): void {
    const { id } = dialog.request;
    if (slot.pendingExtensionDialogs.get(id) !== dialog) return;
    slot.pendingExtensionDialogs.delete(id);
    clearTimeout(dialog.timer);
    this.host.emitSlotEvent(slot, { type: "extension_ui_remove", id, reason });
    this.host.scheduleIdleWorkerEviction();
  }

  private async respondInside(
    response: Record<string, unknown>,
    expected?: { slot: RuntimeSlot; dialog: PendingExtensionDialog },
  ): Promise<void> {
    const sessionId =
      typeof response.sessionId === "string" ? response.sessionId : "";
    const requestId = typeof response.id === "string" ? response.id : "";
    const slot = this.host.slot(sessionId);
    if (!slot)
      throw requestError(
        "The extension request no longer has a live Pi runtime",
        409,
      );
    const { sessionId: _owner, ...wireResponse } = response;
    const stillExpected = () =>
      !expected ||
      (slot === expected.slot &&
        slot.process === expected.dialog.process &&
        slot.pendingExtensionDialogs.get(requestId) === expected.dialog);
    await this.host.extensionResponseSlot(slot, async () => {
      // An explicit answer, expiry or worker retirement may win this FIFO.
      if (!stillExpected()) return;
      if (
        !this.host.ownsSlot(sessionId, slot) ||
        slot.conflict ||
        slot.projection?.health.status === "error"
      ) {
        throw requestError(
          slot.conflict?.message ??
            slot.projection?.health.message ??
            "The extension request owner changed",
          409,
        );
      }
      await this.host.reconcileSlot(slot, true);
      if (!stillExpected()) return;
      if (!this.host.ownsSlot(sessionId, slot))
        throw requestError("The extension request owner changed", 409);
      this.host.throwIfConflicted(slot);
      const dialog = slot.pendingExtensionDialogs.get(requestId);
      if (!dialog)
        throw requestError("The extension request is no longer pending", 409);
      const { request, process: rpc } = dialog;
      if (
        request.sessionId !== sessionId ||
        slot.process !== rpc ||
        !slot.ready
      ) {
        throw requestError(
          "The extension request no longer belongs to this worker",
          409,
        );
      }
      if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) {
        this.remove(slot, dialog, "expired");
        if (expected) return;
        throw requestError(
          "The extension request expired before the response",
          409,
        );
      }
      try {
        await rpc.sendExtensionUiResponse(wireResponse);
        this.remove(slot, dialog, "answered");
        // stdin order makes the correlated read a consumption fence.
        await rpc.request({ type: "get_state" });
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
