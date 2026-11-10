import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Download,
  GitBranch,
  GitFork,
  GripVertical,
  Pencil,
} from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  BranchLeavesResponse,
  SessionActionId,
} from "../../shared/contracts";
import { relativeTime } from "../format";
import { isComposingKeyboardEvent } from "../keyboard-input";
import {
  SESSION_ACTION_LABELS,
  SESSION_ACTION_VISIBLE_COUNT,
} from "../session-actions";
import { useCopied } from "../use-copied";
import {
  type FloatingMenuConstraints,
  useFloatingMenuPlacement,
} from "../use-floating-menu";
import { shallowEqual, store, useAppState } from "../store";
import { useSessionActionReorder } from "../use-session-action-reorder";
import { ButtonLabel } from "./ButtonLabel";
import { CopyFeedback } from "./CopyFeedback";

const CONSTRAINTS: FloatingMenuConstraints = {
  gap: 4,
  horizontalMargin: 8,
  verticalMargin: 4,
  maxWidth: 268,
  maxHeight: 320,
  preferredDirection: "down",
};

const EXPANDED_CONSTRAINTS = { ...CONSTRAINTS, maxHeight: 360 };
const ACTION_ICONS = {
  rename: Pencil,
  clone: GitBranch,
  "switch-branch": GitFork,
  export: Download,
};

type BranchListResult =
  | { branches: BranchLeavesResponse; error?: never }
  | { branches?: never; error: string };

export function SessionActionsMenu({
  anchorRef,
  sessionId,
  actionOrder,
  onOrderChange,
  onCopyError,
  cloneDisabled,
  renameDisabled = false,
  onRename,
  onClone,
  onExport,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  sessionId: string;
  actionOrder: readonly SessionActionId[];
  onOrderChange: (order: SessionActionId[]) => void;
  onCopyError: (message: string) => void;
  cloneDisabled: boolean;
  renameDisabled?: boolean;
  onRename: () => void;
  onClone: () => void;
  onExport: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const overflowRef = useRef<HTMLButtonElement | null>(null);
  const focusRevealed = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const { viewId, revision, leafId } = useAppState(
    (state) =>
      state.sessionId === sessionId
        ? {
            viewId: state.transcriptViewId,
            revision: state.transcriptRevision,
            leafId: state.transcriptEffectiveLeafId,
          }
        : { viewId: null, revision: null, leafId: null },
    shallowEqual,
  );
  const [retry, setRetry] = useState(0);
  const branchReadKey = JSON.stringify([
    sessionId,
    viewId,
    revision,
    leafId,
    retry,
  ]);
  const [branchRead, setBranchRead] = useState<{
    key: string;
    result: BranchListResult;
  } | null>(null);
  const result = branchRead?.key === branchReadKey ? branchRead.result : null;
  const branches = result?.branches;
  const [choosingBranch, setChoosingBranch] = useState(false);
  useEffect(() => {
    let current = true;
    void store.branchLeaves(sessionId).then(
      (branches) =>
        current && setBranchRead({ key: branchReadKey, result: { branches } }),
      () =>
        current &&
        setBranchRead({
          key: branchReadKey,
          result: { error: "Could not load branches." },
        }),
    );
    return () => {
      current = false;
    };
  }, [branchReadKey, sessionId]);
  const branchViewChanged = useRef(false);
  useLayoutEffect(() => {
    // Opening keeps the menu's own focus; only switching views moves it.
    if (!branchViewChanged.current) {
      branchViewChanged.current = true;
      return;
    }
    const menu = menuRef.current;
    const target = choosingBranch
      ? (menu?.querySelector<HTMLButtonElement>(
          ".session-actions-menu__branch",
        ) ??
        menu?.querySelector<HTMLButtonElement>(
          ".session-actions-menu__branch-back",
        ))
      : (menu?.querySelector<HTMLButtonElement>(
          '[data-session-action-id="switch-branch"] [data-session-action]:not(:disabled)',
        ) ?? overflowRef.current);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
  }, [choosingBranch]);
  const { copied, copying, copy } = useCopied({
    scope: sessionId,
    onError: onCopyError,
  });
  const actions: Record<
    SessionActionId,
    { run: () => void; disabled?: boolean; title?: string }
  > = {
    rename: { run: onRename, disabled: renameDisabled },
    "copy-id": {
      run: () => {
        if (!copying) void copy(sessionId);
      },
    },
    clone: { run: onClone, disabled: cloneDisabled },
    "switch-branch": {
      run: () => setChoosingBranch(true),
      disabled: !result || Boolean(branches && branches.total < 2),
      title:
        branches && branches.total < 2
          ? "This session has no other branch"
          : undefined,
    },
    export: { run: onExport },
  };
  const reorder = useSessionActionReorder({
    order: actionOrder,
    onChange: onOrderChange,
    containerRef: menuRef,
    onReorderStart: () => setExpanded(true),
  });
  const visibleActions = expanded
    ? reorder.order
    : reorder.order.slice(0, SESSION_ACTION_VISIBLE_COUNT);

  useLayoutEffect(() => {
    if (expanded && focusRevealed.current) {
      focusRevealed.current = false;
      const firstRevealed = menuRef.current?.querySelector<HTMLButtonElement>(
        "[data-overflow-action]:not(:disabled)",
      );
      (firstRevealed ?? overflowRef.current)?.focus({ preventScroll: true });
      firstRevealed?.scrollIntoView({ block: "nearest" });
    }
  }, [expanded]);
  const resolveTarget = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return null;
    const rect = anchor.getBoundingClientRect();
    return {
      context: anchor,
      anchor: rect,
      observe: [anchor],
    };
  }, [anchorRef]);
  const placement = useFloatingMenuPlacement(
    true,
    resolveTarget,
    expanded ? EXPANDED_CONSTRAINTS : CONSTRAINTS,
  );
  const attachMenu = useCallback((node: HTMLDivElement | null) => {
    menuRef.current = node;
    node
      ?.querySelector<HTMLButtonElement>("[data-session-action]:not(:disabled)")
      ?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !anchorRef.current?.contains(target)
      )
        onClose();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("focusin", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("focusin", dismiss);
    };
  }, [anchorRef, onClose]);

  if (!placement) return null;
  return createPortal(
    <div
      ref={attachMenu}
      className="session-actions-menu"
      role="menu"
      aria-label="Session actions"
      style={{
        left: placement.left,
        top: placement.top,
        bottom: placement.bottom,
        width: "max-content",
        maxWidth: placement.width,
        maxHeight: placement.maxHeight,
      }}
      onPointerMove={reorder.onPointerMove}
      onPointerUp={reorder.onPointerUp}
      onPointerCancel={reorder.onPointerCancel}
      onLostPointerCapture={reorder.onPointerCancel}
      onKeyDown={(event) => {
        if (isComposingKeyboardEvent(event.nativeEvent)) return;
        if (reorder.onKeyDown(event)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
          }
          onClose();
          anchorRef.current?.focus({ preventScroll: true });
          return;
        }
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ];
        const index = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "ArrowDown"
            ? (index + 1) % items.length
            : event.key === "ArrowUp"
              ? (index - 1 + items.length) % items.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : null;
        if (next !== null) {
          event.preventDefault();
          items[next]?.focus();
        }
      }}
    >
      {choosingBranch ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="session-actions-menu__overflow session-actions-menu__branch-back"
            onClick={() => setChoosingBranch(false)}
          >
            <ChevronLeft size={14} aria-hidden />
            <span>Back to actions</span>
          </button>
          {!result ? (
            <p className="session-actions-menu__note" role="status">
              Loading branches…
            </p>
          ) : result.error ? (
            <>
              <p className="session-actions-menu__note" role="alert">
                {result.error}
              </p>
              <button
                type="button"
                role="menuitem"
                className="session-actions-menu__branch"
                onClick={() => {
                  menuRef.current
                    ?.querySelector<HTMLButtonElement>(
                      ".session-actions-menu__branch-back",
                    )
                    ?.focus();
                  setRetry((count) => count + 1);
                }}
              >
                Retry
              </button>
            </>
          ) : branches && branches.total < 2 ? (
            <p className="session-actions-menu__note">
              This session has no other branch.
            </p>
          ) : null}
          {branches &&
            branches.total >= 2 &&
            branches.leaves.map((leaf) => (
              <button
                key={leaf.id}
                type="button"
                role="menuitemradio"
                aria-checked={leaf.isCurrent}
                className="session-actions-menu__branch"
                onClick={() => {
                  if (leaf.isCurrent) return onClose();
                  void store.selectBranch(sessionId, leaf.id).then((done) => {
                    if (done) onClose();
                  });
                }}
              >
                <span className="session-actions-menu__branch-mark">
                  {leaf.isCurrent ? <Check size={14} aria-hidden /> : null}
                </span>
                <span className="session-actions-menu__branch-text">
                  <span>{leaf.excerpt || "No message"}</span>
                  <span className="session-actions-menu__branch-meta">
                    {relativeTime(leaf.updatedAt)}
                    {leaf.isDefault ? " · Default" : ""}
                  </span>
                </span>
              </button>
            ))}
          {branches && branches.total > branches.leaves.length ? (
            <p className="session-actions-menu__note">
              History shows all {branches.total} branches.
            </p>
          ) : null}
        </>
      ) : null}
      {!choosingBranch &&
        visibleActions.map((id, index) => {
          const Icon = id === "copy-id" ? null : ACTION_ICONS[id];
          const action = actions[id];
          return (
            <div
              key={id}
              role="none"
              className="session-actions-menu__row"
              data-session-action-id={id}
              data-dragging={reorder.draggingId === id || undefined}
            >
              <button
                type="button"
                role="menuitem"
                data-session-action
                data-copied={id === "copy-id" && copied ? "true" : undefined}
                data-overflow-action={
                  index >= SESSION_ACTION_VISIBLE_COUNT || undefined
                }
                disabled={action.disabled}
                title={action.title}
                aria-disabled={id === "copy-id" ? copying : undefined}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                onClick={action.run}
              >
                {id === "copy-id" ? (
                  <CopyFeedback copied={copied} copying={copying} size={14} />
                ) : Icon ? (
                  <Icon size={14} aria-hidden />
                ) : null}
                <ButtonLabel
                  reserve={
                    id === "copy-id" && copied ? SESSION_ACTION_LABELS[id] : []
                  }
                >
                  {id === "copy-id" && copied
                    ? "ID copied"
                    : SESSION_ACTION_LABELS[id]}
                </ButtonLabel>
              </button>
              <button
                type="button"
                role="menuitem"
                className="session-actions-menu__handle"
                aria-label={`Reorder ${SESSION_ACTION_LABELS[id]}`}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                title="Drag to reorder · Alt+↑/↓ to move"
                onPointerDown={(event) => reorder.startDrag(event, id)}
              >
                <GripVertical size={14} aria-hidden />
              </button>
            </div>
          );
        })}
      {!choosingBranch && actionOrder.length > SESSION_ACTION_VISIBLE_COUNT ? (
        <>
          <button
            key="overflow"
            ref={overflowRef}
            type="button"
            role="menuitem"
            className="session-actions-menu__overflow"
            aria-expanded={expanded}
            onClick={() => {
              focusRevealed.current = !expanded;
              setExpanded(!expanded);
            }}
          >
            {expanded ? (
              <ChevronUp size={14} aria-hidden />
            ) : (
              <ChevronDown size={14} aria-hidden />
            )}
            <span>{expanded ? "Fewer actions" : "More actions"}</span>
          </button>
        </>
      ) : null}
      <span className="sr-only" role="status">
        {copied ? "Session ID copied" : ""}
      </span>
    </div>,
    document.body,
  );
}
