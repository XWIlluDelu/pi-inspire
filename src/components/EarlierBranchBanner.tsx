import { GitBranch } from "lucide-react";
import { memo, useState } from "react";
import { shallowEqual, store, useAppState } from "../store";
import { NoticeCard } from "./NoticeCard";
import { PiLoader } from "./PiLoader";

export const EarlierBranchBanner = memo(function EarlierBranchBanner({
  restoreSavedLeafId,
}: {
  restoreSavedLeafId: string;
}) {
  const { actionId, treeError } = useAppState(
    (state) => ({
      actionId: state.branchActionId,
      treeError: state.branchTreeError,
    }),
    shallowEqual,
  );
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const busy = actionId !== null;
  const returning = actionId === `switch:${restoreSavedLeafId}`;
  return (
    <NoticeCard
      compact
      kind="info"
      className="earlier-branch-banner"
      icon={<GitBranch size={14} />}
      dismissLabel="Dismiss earlier continuation notice"
      onDismiss={() => {
        document
          .querySelector<HTMLElement>("main .transcript-wrap")
          ?.focus({ preventScroll: true });
        setDismissed(true);
      }}
    >
      <div>Next message continues from earlier history.</div>
      <button
        type="button"
        className="button button--quiet earlier-branch-banner__restore"
        disabled={busy}
        aria-busy={returning || undefined}
        onClick={() => void store.branches.returnToLatest()}
      >
        {returning && <PiLoader size={13} aria-hidden />}
        Continue from latest saved point
      </button>
      {treeError && <div role="alert">{treeError}</div>}
    </NoticeCard>
  );
});
