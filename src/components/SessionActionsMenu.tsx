import { Check, ChevronLeft, GitBranch, GripVertical } from "lucide-react";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { SessionHistoryPages } from "../../shared/contracts";
import { relativeTime } from "../format";
import {
  runSessionAction,
  sessionActionAvailable,
  sessionActions,
  type SessionInspection,
} from "../session-actions";
import { shallowEqual, store, useAppState } from "../store";
import { useCopied } from "../use-copied";
import { useSessionActionReorder } from "../use-session-action-reorder";
import { ButtonLabel } from "./ButtonLabel";
import { AnchoredPanel } from "./ChoicePanel";
import { CopyFeedback } from "./CopyFeedback";

export function SessionActionsMenu({
  anchorRef,
  initialBranchSelection = false,
  sessionId,
  onRename,
  onInspect,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  initialBranchSelection?: boolean;
  sessionId: string;
  onRename: (sessionId: string, name: string) => void;
  onInspect: (kind: SessionInspection) => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const { order, rename, clone, toolLoadout, viewId, revision, readOnly, action, error } =
    useAppState(
      (state) => ({
        order:
          state.desiredPreferences.sessionActionOrder ??
          state.prefs.sessionActionOrder,
        viewId: state.view.viewId,
        revision: state.view.branchRevision,
        readOnly: Boolean(state.readOnlyReason),
        action: state.branchActionId,
        error: state.branchTreeError,
        rename: sessionActionAvailable("rename", state),
        clone: sessionActionAvailable("clone", state),
        toolLoadout: sessionActionAvailable("tool-loadout", state),
      }),
      shallowEqual,
    );
  const { copied, copying, copy } = useCopied({
    scope: sessionId,
    onError: store.reportCopyError,
  });
  const [choosing, setChoosing] = useState(initialBranchSelection);
  const [retry, setRetry] = useState(0);
  const [branchRead, setBranchRead] = useState<{
    viewId: string;
    retry: number;
    data: SessionHistoryPages["branches"] | null;
    error?: string;
  }>();
  const branches =
    branchRead?.viewId === viewId && branchRead.retry === retry
      ? branchRead
      : null;
  const back = useRef<HTMLButtonElement>(null);
  const switchAction = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (choosing) back.current?.focus({ preventScroll: true });
  }, [choosing]);
  useEffect(() => {
    if (!choosing || !viewId) return;
    const request = new AbortController();
    void store
      .readNativeHistory(
        sessionId,
        viewId,
        { kind: "branches" },
        request.signal,
      )
      .then(
        (data) => {
          if (!request.signal.aborted && data)
            setBranchRead({ viewId, retry, data });
        },
        (error: unknown) => {
          if (!request.signal.aborted)
            setBranchRead({
              viewId,
              retry,
              data: null,
              error:
                error instanceof Error
                  ? error.message
                  : "Could not load branches",
            });
        },
      );
    return () => request.abort();
  }, [choosing, retry, sessionId, viewId]);
  const list = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const reorder = useSessionActionReorder({
    order,
    onChange: (next) => store.setPreference("sessionActionOrder", next),
    containerRef: list,
    onMove: (id, index) =>
      setAnnouncement(
        `${sessionActions[id].title} moved to position ${index + 1}`,
      ),
  });
  return (
    <AnchoredPanel
      anchorRef={anchorRef}
      label="Session actions"
      open
      onClose={onClose}
      role="menu"
    >
      {choosing ? (
        <>
          <button
            ref={back}
            role="menuitem"
            type="button"
            onClick={() => {
              setChoosing(false);
              requestAnimationFrame(() =>
                switchAction.current?.focus({ preventScroll: true }),
              );
            }}
          >
            <ChevronLeft size={14} aria-hidden />
            Back to actions
          </button>
          {!branches && (
            <p className="session-actions-menu__note" role="status">
              Loading branches…
            </p>
          )}
          {branches?.error && (
            <>
              <p className="session-actions-menu__note" role="alert">
                {branches.error}
              </p>
              <button
                type="button"
                role="menuitem"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry
              </button>
            </>
          )}
          {branches?.data?.total === 1 && (
            <p className="session-actions-menu__note">
              This session has no other branch.
            </p>
          )}
          {branches?.data?.leaves.map((leaf) => (
            <button
              type="button"
              role="menuitem"
              className="session-actions-menu__branch"
              key={leaf.id}
              aria-current={leaf.isCurrent ? "location" : undefined}
              disabled={leaf.isCurrent || Boolean(action) || revision === null}
              onClick={() => {
                if (
                  store.getState().sessionId !== sessionId ||
                  revision === null
                )
                  return;
                void store
                  .navigateBranch(
                    leaf.id,
                    readOnly ? "watch" : "switch",
                    {},
                    revision,
                  )
                  .then((ok) => {
                    if (ok) onClose(true);
                  });
              }}
            >
              {leaf.isCurrent ? (
                <Check size={14} aria-hidden />
              ) : (
                <GitBranch size={14} aria-hidden />
              )}
              <span>{leaf.excerpt || "Untitled branch"}</span>
              <small>{relativeTime(leaf.updatedAt)}</small>
            </button>
          ))}
          {error && (
            <p className="session-actions-menu__note" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <div
          ref={list}
          role="presentation"
          onPointerMove={reorder.onPointerMove}
          onPointerUp={reorder.onPointerUp}
          onPointerCancel={reorder.onPointerCancel}
          onLostPointerCapture={reorder.onPointerCancel}
          onKeyDownCapture={(event) => {
            if (reorder.onKeyDown(event)) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          {reorder.order.map((id) => {
            const { icon: Icon, title } = sessionActions[id];
            const copyId = id === "copy-id";
            return (
              <div
                key={id}
                role="presentation"
                className="session-actions-menu__row"
                data-session-action-id={id}
                data-dragging={reorder.draggingId === id || undefined}
              >
                <button
                  type="button"
                  role="menuitem"
                  ref={id === "switch-branch" ? switchAction : undefined}
                  disabled={
                    (id === "rename" && !rename) ||
                    (id === "clone" && !clone) ||
                    (id === "tool-loadout" && !toolLoadout)
                  }
                  aria-disabled={copyId ? copying : undefined}
                  onClick={() => {
                    if (id === "switch-branch") {
                      setChoosing(true);
                      return;
                    }
                    runSessionAction(id, sessionId, {
                      copyId: () => {
                        if (!copying)
                          void copy(sessionId, store.copyOwnership());
                      },
                      rename: onRename,
                      inspect: onInspect,
                      closeMenu: onClose,
                    });
                  }}
                >
                  {Icon ? (
                    <Icon size={14} aria-hidden />
                  ) : (
                    <CopyFeedback copied={copied} copying={copying} size={14} />
                  )}
                  <ButtonLabel reserve={copyId && copied ? title : []}>
                    {copyId && copied ? "ID copied" : title}
                  </ButtonLabel>
                </button>
                <button
                  type="button"
                  className="session-actions-menu__grip"
                  tabIndex={-1}
                  aria-label={`Reorder ${title}`}
                  title="Drag to reorder"
                  onPointerDown={(event) => reorder.startDrag(event, id)}
                >
                  <GripVertical size={14} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <span className="sr-only" role="status">
        {copied ? "Session ID copied" : announcement}
      </span>
    </AnchoredPanel>
  );
}
