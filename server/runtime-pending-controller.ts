import {
  type PendingManagementAction,
  type PendingQueues,
} from "../shared/contracts.js";
import {
  isPiRpcOutcomeUnknown,
  type PiRpcOutcomeUnknownError,
  type PiRpcProcess,
} from "./pi-rpc.js";
import {
  MAX_PENDING_TEXT_RESPONSE_BYTES,
  newestPendingQueues,
  pendingQueuesFromRecord,
} from "./runtime-pending.js";
import type { RuntimeSlot } from "./runtime-slot.js";

interface RuntimePendingControllerHost {
  withMaintenance<T>(operation: () => Promise<T>): Promise<T>;
  requireSlot(sessionId: string): RuntimeSlot;
  mutateSlot<T>(slot: RuntimeSlot, operation: () => Promise<T>): Promise<T>;
  useSlot<T>(slot: RuntimeSlot, operation: () => Promise<T>): Promise<T>;
  ensureWriter(slot: RuntimeSlot): Promise<PiRpcProcess>;
  failUnknown(
    slot: RuntimeSlot,
    error: PiRpcOutcomeUnknownError,
  ): Promise<never>;
}

/** Owns bounded Pending queue mutations and text retrieval against Pi's
 * revisioned management protocol. */
export class RuntimePendingController {
  constructor(private readonly host: RuntimePendingControllerHost) {}

  manage(
    sessionId: string,
    request: PendingManagementAction,
  ): Promise<PendingQueues> {
    return this.host.withMaintenance(async () => {
      const slot = this.host.requireSlot(sessionId);
      return this.host.mutateSlot(slot, async () => {
        if (!slot.pendingQueues.managementAvailable) {
          throw Object.assign(
            new Error(
              "The active Pi runtime does not support Pending management",
            ),
            { status: 409 },
          );
        }
        if (slot.pendingQueues.revision !== request.expectedRevision) {
          throw Object.assign(
            new Error("Pending changed; refresh before trying again"),
            { status: 409 },
          );
        }
        const process = await this.host.ensureWriter(slot);
        const command: Record<string, unknown> = (() => {
          switch (request.action) {
            case "pause":
              return {
                type: "pause_pending",
                expectedRevision: request.expectedRevision,
              };
            case "resume":
              return {
                type: "resume_pending",
                expectedRevision: request.expectedRevision,
              };
            case "delete":
              return {
                type: "delete_pending_message",
                messageId: request.messageId,
                expectedRevision: request.expectedRevision,
              };
            case "clear":
              return {
                type: "clear_pending_messages",
                expectedRevision: request.expectedRevision,
              };
            case "convert":
              return {
                type: "convert_pending_message",
                messageId: request.messageId,
                target: request.target,
                expectedRevision: request.expectedRevision,
              };
          }
        })();
        let result: unknown;
        try {
          result = await process.request(command);
        } catch (error) {
          if (isPiRpcOutcomeUnknown(error))
            return this.host.failUnknown(slot, error);
          const message =
            error instanceof Error ? error.message : String(error);
          throw Object.assign(new Error(message), {
            status: /pending|queue|unknown command|not found/i.test(message)
              ? 409
              : 500,
          });
        }
        const pending = pendingQueuesFromRecord(
          result,
          undefined,
          undefined,
          slot.pendingQueues.revision,
        );
        if (
          !pending.managementAvailable ||
          pending.revision < request.expectedRevision
        ) {
          throw Object.assign(
            new Error("Pi returned an invalid Pending state"),
            { status: 502 },
          );
        }
        slot.pendingQueues = newestPendingQueues(slot.pendingQueues, pending);
        return structuredClone(slot.pendingQueues);
      });
    });
  }

  messageTexts(
    sessionId: string,
    messageIds: readonly string[],
  ): Promise<Array<{ id: string; text: string }>> {
    return this.host.withMaintenance(async () => {
      const slot = this.host.requireSlot(sessionId);
      return this.host.useSlot(slot, async () => {
        const process = slot.process;
        if (
          !process ||
          !slot.ready ||
          !slot.pendingQueues.managementAvailable
        ) {
          throw Object.assign(
            new Error("The Pending messages are no longer available"),
            { status: 409 },
          );
        }
        try {
          const expectedRevision = slot.pendingQueues.revision;
          const messages: Array<{ id: string; text: string }> = [];
          let textBytes = 0;
          // One message per response keeps any accepted queue below Pi's
          // bounded stdout frame; one revision prevents a mixed incarnation.
          for (const messageId of messageIds) {
            const result = await process.request<{ messages?: unknown }>({
              type: "get_pending_message_texts",
              messageIds: [messageId],
              expectedRevision,
            });
            if (!Array.isArray(result.messages) || result.messages.length !== 1)
              throw Object.assign(
                new Error("Pi returned invalid Pending messages"),
                { status: 502 },
              );
            const value = result.messages[0];
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw Object.assign(
                new Error("Pi returned invalid Pending messages"),
                { status: 502 },
              );
            const record = value as Record<string, unknown>;
            if (record.id !== messageId || typeof record.text !== "string")
              throw Object.assign(
                new Error("Pi returned the wrong Pending messages"),
                { status: 502 },
              );
            textBytes += Buffer.byteLength(record.text, "utf8");
            if (textBytes > MAX_PENDING_TEXT_RESPONSE_BYTES)
              throw Object.assign(
                new Error("Pending text exceeds the 4 MiB copy limit"),
                { status: 413 },
              );
            messages.push({ id: messageId, text: record.text });
          }
          return messages;
        } catch (error) {
          if (isPiRpcOutcomeUnknown(error))
            return this.host.failUnknown(slot, error);
          if (error && typeof error === "object" && "status" in error)
            throw error;
          const message =
            error instanceof Error ? error.message : String(error);
          throw Object.assign(new Error(message), {
            status: /exceeds.*limit/i.test(message)
              ? 413
              : /pending|not found|unknown command/i.test(message)
                ? 409
                : 500,
          });
        }
      });
    });
  }
}
