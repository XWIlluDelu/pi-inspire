import { GitBranch, X } from "lucide-react";
import { memo, useRef, useState } from "react";
import { hasEarlierContinuation } from "../controllers/branch-controller";
import { shallowEqual, store, useAppState } from "../store";
import { PiLoader } from "./PiLoader";

export const EarlierBranchBanner = memo(function EarlierBranchBanner() {
  const { earlierContinuation, durableLeafId, actionId, treeError } =
    useAppState(
      (state) => ({
        earlierContinuation: hasEarlierContinuation(state),
        durableLeafId: state.view.durableLeafId,
        actionId: state.branchActionId,
        treeError: state.branchTreeError,
      }),
      shallowEqual,
    );
  const [dismissed, setDismissed] = useState(false);
  const bannerRef = useRef<HTMLElement>(null);
  if (!earlierContinuation || dismissed) return null;

  const busy = actionId !== null;
  const returning = actionId === `switch:${durableLeafId}`;
  return (
    <section
      ref={bannerRef}
      className="earlier-branch-banner"
      aria-label="Earlier continuation"
    >
      <div className="earlier-branch-banner__header">
        <GitBranch size={14} aria-hidden />
        <span>Continuing from earlier history</span>
      </div>
      <button
        type="button"
        className="button button--quiet earlier-branch-banner__restore"
        disabled={busy}
        aria-busy={returning || undefined}
        title="Continue your next message from the latest saved point in this session"
        onClick={() => void store.returnToLatestBranch()}
      >
        {returning ? <PiLoader size={13} aria-hidden /> : null}
        Restore saved position
      </button>
      <button
        type="button"
        className="icon-button earlier-branch-banner__dismiss"
        aria-label="Dismiss earlier continuation notice"
        title="Dismiss notice"
        onClick={() => {
          bannerRef.current
            ?.closest<HTMLElement>(".transcript-wrap")
            ?.focus({ preventScroll: true });
          setDismissed(true);
        }}
      >
        <X size={14} aria-hidden />
      </button>
      {treeError ? (
        <span className="earlier-branch-banner__error" role="alert">
          {treeError}
        </span>
      ) : null}
    </section>
  );
});
