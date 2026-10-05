import type { ComposerHistoryEntry } from "../shared/contracts.js";
import type { PiRpcProcess, PiRpcResponseFence } from "./pi-rpc.js";
import { requestError } from "./request-error.js";
import type { RuntimeSlot } from "./runtime-slot.js";

export interface NativeBashExecution {
  worker: PiRpcProcess;
  fence: PiRpcResponseFence;
  message: Record<string, unknown>;
  finished: Promise<void>;
}

interface RuntimeBashHost {
  admit(slot: RuntimeSlot): Promise<PiRpcProcess>;
  request(
    slot: RuntimeSlot,
    worker: PiRpcProcess,
    command: Record<string, unknown>,
    fence: PiRpcResponseFence,
  ): Promise<Record<string, unknown>>;
  updateOverlay(
    slot: RuntimeSlot,
    message: unknown,
    phase: "start" | "update" | "end",
  ): unknown;
  emit(slot: RuntimeSlot, event: unknown): void;
  reconcile(slot: RuntimeSlot): Promise<unknown>;
}

const OUTPUT_PREVIEW_CHARS = 50_000;

/** Runs the public Pi bash command, never a Host shell or model prompt. */
export class RuntimeBashController {
  constructor(private readonly host: RuntimeBashHost) {}

  async execute(
    slot: RuntimeSlot,
    entered: string,
  ): Promise<ComposerHistoryEntry> {
    const excludeFromContext = entered.startsWith("!!");
    const command = entered.slice(excludeFromContext ? 2 : 1).trim();
    if (!command) throw requestError("Enter a command after ! or !!", 400);
    if (slot.nativeBash)
      throw requestError(
        "A shell command is already running; stop it first",
        409,
      );
    const worker = await this.host.admit(slot);
    // Startup is asynchronous: another delivery or Stop can win admission.
    if (slot.nativeBash)
      throw requestError(
        "A shell command is already running; stop it first",
        409,
      );
    if (slot.stoppingInput)
      throw requestError(
        "Stop is in progress; send again after it finishes",
        409,
      );
    const message: Record<string, unknown> = {
      role: "bashExecution",
      command,
      output: "",
      excludeFromContext,
      timestamp: Date.now(),
      __inspireBashRunning: true,
    };
    let finish!: () => void;
    const execution: NativeBashExecution = {
      worker,
      fence: { received: false },
      message,
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    slot.nativeBash = execution;
    this.publish(slot, execution, "start");
    try {
      const result = await this.host.request(
        slot,
        worker,
        { type: "bash", command, excludeFromContext },
        execution.fence,
      );
      if (slot.process !== worker)
        throw new Error("The Pi shell worker stopped");
      execution.message = {
        ...message,
        ...result,
        role: "bashExecution",
        command,
        excludeFromContext,
        __inspireBashRunning: false,
      };
      this.publish(slot, execution, "end");
      // During an agent run Pi defers this message until agent_end. The ordinary
      // reconciler adopts its exact result then, without disturbing tool order.
      await this.host.reconcile(slot);
      return { text: entered, images: [], files: [] };
    } catch (error) {
      if (slot.process === worker) {
        execution.message = {
          ...execution.message,
          __inspireBashRunning: false,
          __inspireBashError:
            error instanceof Error ? error.message : String(error),
        };
        this.publish(slot, execution, "end");
      }
      throw error;
    } finally {
      if (slot.nativeBash === execution) {
        slot.nativeBash = null;
        this.host.emit(slot, { type: "bash_finished", bashRunning: false });
      }
      finish();
    }
  }

  /** Retirement ends the transient presentation, never fabricates a Pi result. */
  retire(slot: RuntimeSlot, worker: PiRpcProcess): void {
    const execution = slot.nativeBash;
    if (
      !execution ||
      execution.worker !== worker ||
      execution.message.__inspireBashRunning !== true
    )
      return;
    execution.message = {
      ...execution.message,
      __inspireBashRunning: false,
      __inspireBashInterrupted: true,
      __inspireBashError:
        "Pi worker retired before its shell result was confirmed; inspect the session before resending.",
    };
    this.publish(slot, execution, "end");
  }

  update(slot: RuntimeSlot, event: Record<string, unknown>): boolean {
    const execution = slot.nativeBash;
    if (
      !execution ||
      execution.message.__inspireBashRunning !== true ||
      event.id !== execution.fence.id ||
      typeof event.delta !== "string"
    )
      return false;
    const previous = String(execution.message.output ?? "");
    const output = `${previous}${event.delta}`;
    execution.message = {
      ...execution.message,
      output: output.slice(-OUTPUT_PREVIEW_CHARS),
      __inspireBashPreviewTruncated:
        execution.message.__inspireBashPreviewTruncated === true ||
        output.length > OUTPUT_PREVIEW_CHARS,
    };
    this.publish(slot, execution, "update");
    return true;
  }

  private publish(
    slot: RuntimeSlot,
    execution: NativeBashExecution,
    phase: "start" | "update" | "end",
  ): void {
    const projected = this.host.updateOverlay(slot, execution.message, phase);
    this.host.emit(slot, {
      type: `message_${phase}`,
      message: projected,
      bashRunning: phase !== "end",
      shellExecution: true,
    });
  }
}
