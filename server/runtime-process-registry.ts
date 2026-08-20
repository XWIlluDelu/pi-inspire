import type { PiRpcProcess } from "./pi-rpc.js";
import type { RuntimeSlot } from "./runtime-slot.js";

/**
 * One registry binds each Pi process instance to exactly one mutable runtime
 * slot. RuntimeController owns slot meaning and cleanup policy; this helper
 * owns process-instance identity and guarantees event listeners are attached
 * once even when a fork rebinds the same child to its destination slot.
 */
interface RuntimeProcessRegistryHost {
  recordProcessAttachment(slot: RuntimeSlot, rpc: PiRpcProcess): void;
  dispatchProcessEvent(rpc: PiRpcProcess, event: unknown): void;
  handleProcessExit(slot: RuntimeSlot, rpc: PiRpcProcess, error: Error): void;
}

export class RuntimeProcessRegistry {
  private readonly owners = new WeakMap<PiRpcProcess, RuntimeSlot>();
  private readonly attached = new WeakSet<PiRpcProcess>();

  constructor(private readonly host: RuntimeProcessRegistryHost) {}

  ownerOf(rpc: PiRpcProcess): RuntimeSlot | undefined {
    return this.owners.get(rpc);
  }

  attach(slot: RuntimeSlot, rpc: PiRpcProcess): void {
    this.owners.set(rpc, slot);
    this.host.recordProcessAttachment(slot, rpc);
    if (this.attached.has(rpc)) return;
    this.attached.add(rpc);
    rpc.on("event", (event) => this.host.dispatchProcessEvent(rpc, event));
    rpc.on("exit", (error: Error) => {
      const owner = this.owners.get(rpc);
      if (!owner || owner.process !== rpc) return;
      this.owners.delete(rpc);
      this.host.handleProcessExit(owner, rpc, error);
    });
  }

  detach(rpc: PiRpcProcess): void {
    this.owners.delete(rpc);
  }

  rebind(rpc: PiRpcProcess, destination: RuntimeSlot): void {
    this.owners.set(rpc, destination);
  }
}
