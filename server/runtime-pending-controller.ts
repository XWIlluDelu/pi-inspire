import {
  isPiRpcOutcomeUnknown,
  type PiRpcOutcomeUnknownError,
  type PiRpcProcess,
} from "./pi-rpc.js";
import type { RuntimeSlot } from "./runtime-slot.js";

interface RuntimePendingControllerHost {
  withMaintenance<T>(operation: () => Promise<T>): Promise<T>;
  requireSlot(sessionId: string): RuntimeSlot;
  mutateSlot<T>(slot: RuntimeSlot, operation: () => Promise<T>): Promise<T>;
  ensureWriter(slot: RuntimeSlot): Promise<PiRpcProcess>;
  failUnknown(
    slot: RuntimeSlot,
    error: PiRpcOutcomeUnknownError,
  ): Promise<never>;
}

export class RuntimePendingController {
  constructor(private readonly host: RuntimePendingControllerHost) {}

  clear(sessionId: string): Promise<void> {
    return this.host.withMaintenance(async () => {
      const slot = this.host.requireSlot(sessionId);
      return this.host.mutateSlot(slot, async () => {
        const process = await this.host.ensureWriter(slot);
        try {
          // Clear whatever remains at Pi's current boundary. Consumption may
          // race the request; queue_update, not this receipt, owns the display.
          // Do not retain or forward the potentially large returned texts.
          await process.request({ type: "clear_queue" });
        } catch (error) {
          if (isPiRpcOutcomeUnknown(error))
            return this.host.failUnknown(slot, error);
          throw error;
        }
      });
    });
  }
}
