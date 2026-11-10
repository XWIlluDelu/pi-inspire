import { GitBranch, X } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { hasEarlierContinuation } from "../controllers/branch-controller";
import { shallowEqual, store, useAppState } from "../store";
import { PiLoader } from "./PiLoader";

export const EarlierBranchBanner = memo(function EarlierBranchBanner() {
  const {
    earlierContinuation,
    durableLeafId,
    treeLoading,
    actionId,
    treeError,
  } = useAppState(
    (state) => ({
      earlierContinuation: hasEarlierContinuation(state),
      durableLeafId: state.transcriptDurableLeafId,
      treeLoading: state.branchTreeLoading,
      actionId: state.branchActionId,
      treeError: state.branchTreeError,
    }),
    shallowEqual,
  );
  const [dismissed, setDismissed] = useState(false);
  const visible = earlierContinuation && !dismissed;
  const bannerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    const banner = bannerRef.current;
    const wrap = banner?.parentElement;
    if (!banner || !wrap) return;
    const measure = () => {
      const bottom =
        banner.getBoundingClientRect().bottom -
        wrap.getBoundingClientRect().top;
      wrap.style.setProperty(
        "--earlier-branch-inset",
        `calc(${bottom}px + var(--space-4))`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(banner);
    return () => {
      observer.disconnect();
      wrap.style.removeProperty("--earlier-branch-inset");
    };
  }, [visible]);
  if (!visible) return null;

  const busy = treeLoading || actionId !== null;
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
          bannerRef.current?.parentElement?.focus({ preventScroll: true });
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
