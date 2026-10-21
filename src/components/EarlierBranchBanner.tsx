import { GitBranch } from "lucide-react";
import { memo, useLayoutEffect, useRef } from "react";
import { shallowEqual, store, useAppState } from "../store";
import { PiLoader } from "./PiLoader";

/**
 * The transcript remains the primary context surface while inspecting an
 * earlier branch. This banner intentionally does not live in the optional
 * History pane, so returning to the durable leaf never depends on a drawer.
 */
export const EarlierBranchBanner = memo(function EarlierBranchBanner() {
  const { durableLeafId, effectiveLeafId, treeLoading, actionId, treeError } =
    useAppState(
      (state) => ({
        durableLeafId: state.transcriptDurableLeafId,
        effectiveLeafId: state.transcriptEffectiveLeafId,
        treeLoading: state.branchTreeLoading,
        actionId: state.branchActionId,
        treeError: state.branchTreeError,
      }),
      shallowEqual,
    );
  const viewingEarlierBranch = Boolean(
    durableLeafId && durableLeafId !== effectiveLeafId,
  );
  const bannerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!viewingEarlierBranch) return;
    const banner = bannerRef.current;
    const wrap = banner?.parentElement;
    if (!banner || !wrap) return;
    const measure = () => {
      const bottom =
        banner.getBoundingClientRect().bottom -
        wrap.getBoundingClientRect().top;
      wrap.style.setProperty("--earlier-branch-banner-bottom", `${bottom}px`);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(banner);
    return () => {
      observer?.disconnect();
      wrap.style.removeProperty("--earlier-branch-banner-bottom");
    };
  }, [viewingEarlierBranch]);
  if (!viewingEarlierBranch) return null;

  const busy = treeLoading || actionId !== null;
  const returning = actionId === `switch:${durableLeafId}`;
  const cloning = actionId === "clone:current";
  return (
    <section
      ref={bannerRef}
      className="earlier-branch-banner"
      aria-label="Earlier branch context"
    >
      <div className="earlier-branch-banner__header">
        <GitBranch size={16} aria-hidden />
        <div className="earlier-branch-banner__copy">
          <strong>Continuing from earlier history</strong>
          {treeError ? (
            <span className="earlier-branch-banner__error" role="alert">
              {treeError}
            </span>
          ) : null}
        </div>
      </div>
      <div className="earlier-branch-banner__actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          aria-busy={returning || undefined}
          onClick={() => void store.returnToLatestBranch()}
        >
          {returning ? <PiLoader size={13} aria-hidden /> : null}
          Back to latest
        </button>
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          aria-busy={cloning || undefined}
          title="Copy through this point into a new session with an empty draft"
          onClick={() => void store.cloneCurrentBranch()}
        >
          {cloning ? <PiLoader size={13} aria-hidden /> : null}
          Clone from here
        </button>
      </div>
    </section>
  );
});
