import type {
  TerminalCatalogResponse,
  TerminalDescriptor,
} from "../shared/terminal-contracts";

type PatchResult = "applied" | "stale" | "refresh";

/** One pane project generation. Partial receipts never stand in for a full
 * catalog: an equal-revision poll must still reconcile membership and order. */
export class TerminalCatalogController {
  active = false;
  private value: TerminalCatalogResponse | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly retiredEpochs = new Set<string>();

  constructor(readonly cwd: string | null) {}

  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(next: TerminalCatalogResponse): void {
    this.value = next;
    for (const listener of this.listeners) listener();
  }

  replace(next: TerminalCatalogResponse): boolean {
    if (
      !this.active ||
      next.terminals.some((terminal) => terminal.projectCwd !== this.cwd) ||
      this.retiredEpochs.has(next.catalogEpoch)
    )
      return false;
    const current = this.value;
    if (
      current?.catalogEpoch === next.catalogEpoch &&
      next.revision < current.revision
    )
      return false;
    if (current && current.catalogEpoch !== next.catalogEpoch)
      this.retiredEpochs.add(current.catalogEpoch);
    this.publish(next);
    return true;
  }

  private receipt(epoch: string, revision: number): PatchResult {
    if (!this.active || this.retiredEpochs.has(epoch)) return "stale";
    if (!this.value || this.value.catalogEpoch !== epoch) return "refresh";
    return revision < this.value.revision ? "stale" : "applied";
  }

  upsert(terminal: TerminalDescriptor): PatchResult {
    if (terminal.projectCwd !== this.cwd) return "stale";
    const result = this.receipt(
      terminal.catalogEpoch,
      terminal.catalogRevision,
    );
    if (result !== "applied") return result;
    const current = this.value!;
    const terminals = current.terminals.filter(
      (candidate) => candidate.id !== terminal.id,
    );
    const index = current.terminals.findIndex(
      (candidate) => candidate.id === terminal.id,
    );
    terminals.splice(index < 0 ? terminals.length : index, 0, terminal);
    this.publish({ ...current, revision: terminal.catalogRevision, terminals });
    return "applied";
  }

  remove(
    id: string,
    receipt: { catalogEpoch: string; revision: number },
  ): PatchResult {
    const result = this.receipt(receipt.catalogEpoch, receipt.revision);
    if (result !== "applied") return result;
    this.publish({
      ...this.value!,
      revision: receipt.revision,
      terminals: this.value!.terminals.filter((terminal) => terminal.id !== id),
    });
    return "applied";
  }

  /** Roll back only this exact optimistic order, not a later poll/mutation. */
  order(terminals: TerminalDescriptor[]): () => void {
    const previous = this.value;
    if (!this.active || !previous) return () => {};
    const next = { ...previous, terminals };
    this.publish(next);
    return () => {
      if (this.active && this.value === next) this.publish(previous);
    };
  }
}
