import { GitBranch, Loader2 } from "lucide-react";
import { store, useAppState } from "../store";

/**
 * The transcript remains the primary context surface while inspecting an
 * earlier branch. This banner intentionally does not live in the optional
 * History pane, so returning to the durable leaf never depends on a drawer.
 */
export function EarlierBranchBanner() {
  const state = useAppState();
  const durableLeafId = state.transcriptDurableLeafId;
  const effectiveLeafId = state.transcriptEffectiveLeafId;
  const viewingEarlierBranch = Boolean(
    durableLeafId && effectiveLeafId && durableLeafId !== effectiveLeafId,
  );
  if (!viewingEarlierBranch) return null;

  const busy = state.branchTreeLoading || state.branchActionId !== null;
  return (
    <section
      className="earlier-branch-banner"
      aria-label="Earlier branch context"
    >
      <GitBranch size={16} aria-hidden />
      <div className="earlier-branch-banner__copy">
        <strong>Viewing an earlier branch</strong>
        <span>
          New messages continue from this point until you return to the latest
          branch.
        </span>
        {state.branchTreeError ? (
          <span className="earlier-branch-banner__error" role="alert">
            {state.branchTreeError}
          </span>
        ) : null}
      </div>
      <div className="earlier-branch-banner__actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void store.returnToLatestBranch()}
        >
          {busy ? <Loader2 size={13} className="spin" aria-hidden /> : null}
          Back to latest
        </button>
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={() => void store.forkCurrentBranch()}
        >
          Fork from here
        </button>
      </div>
    </section>
  );
}
