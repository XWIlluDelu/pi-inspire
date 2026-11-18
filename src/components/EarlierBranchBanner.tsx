import { GitBranch } from "lucide-react";
import { memo, useRef, useState } from "react";
import { shallowEqual, store, useAppState } from "../store";
import { NoticeCard } from "./NoticeCard";
import { PiLoader } from "./PiLoader";

export const EarlierBranchBanner = memo(function EarlierBranchBanner() {
  const { restoreSavedLeafId, actionId, treeError } =
    useAppState(
      (state) => ({
        restoreSavedLeafId: state.view.restoreSavedLeafId,
        actionId: state.branchActionId,
        treeError: state.branchTreeError,
      }),
      shallowEqual,
    );
  const [dismissed, setDismissed] = useState(false);
  const bannerRef = useRef<HTMLElement>(null);
  if (!restoreSavedLeafId || dismissed) return null;

  const busy = actionId !== null;
  const returning = actionId === `switch:${restoreSavedLeafId}`;
  return (
    <section
      ref={bannerRef}
      className="earlier-branch-banner"
      aria-label="Earlier continuation"
    >
      <NoticeCard
        kind="info"
        title="Continuing from earlier history"
        icon={<GitBranch size={14} />}
        dismissLabel="Dismiss earlier continuation notice"
        onDismiss={() => {
          bannerRef.current
            ?.closest<HTMLElement>(".transcript-wrap")
            ?.focus({ preventScroll: true });
          setDismissed(true);
        }}
      >
        {treeError && <div role="alert">{treeError}</div>}
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          aria-busy={returning || undefined}
          title="Continue your next message from the latest saved point in this session"
          onClick={() => void store.returnToLatestBranch()}
        >
          {returning && <PiLoader size={13} aria-hidden />}
          Restore saved position
        </button>
      </NoticeCard>
    </section>
  );
});
