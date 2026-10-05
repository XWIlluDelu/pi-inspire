import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ModelIdentity, ModelOption } from "../shared/contracts.js";

export interface BranchModelSelection {
  change: ModelIdentity | null;
  fallback: ModelIdentity | null;
}

export function appendModelSelection(
  previous: BranchModelSelection,
  entries: readonly SessionEntry[],
): BranchModelSelection {
  let { change, fallback } = previous;
  for (const entry of entries) {
    if (entry.type === "model_change") {
      change = fallback = { provider: entry.provider, id: entry.modelId };
    } else if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.api !== "pi-virtual"
    ) {
      fallback = { provider: entry.message.provider, id: entry.message.model };
    }
  }
  return { change, fallback };
}

export function branchModelSelection(
  byId: ReadonlyMap<string, SessionEntry>,
  leaf: string | null,
): BranchModelSelection {
  const branch: SessionEntry[] = [];
  let id = leaf;
  while (id !== null) {
    const entry = byId.get(id);
    if (!entry) break;
    branch.push(entry);
    id = entry.parentId;
  }
  return appendModelSelection(
    { change: null, fallback: null },
    branch.reverse(),
  );
}

/** Pi getBranchSelection: only the latest registered virtual model_change
 * holds across physical replies. Physical/legacy branches keep reply recovery;
 * unavailable virtual definitions fall back to the last physical responder. */
export function selectedBranchModel(
  selection: BranchModelSelection,
  virtualModels: readonly ModelOption[],
): ModelIdentity | ModelOption | null {
  const change = selection.change;
  const virtual =
    change &&
    virtualModels.find(
      (model) => model.provider === change.provider && model.id === change.id,
    );
  return virtual ?? selection.fallback;
}
