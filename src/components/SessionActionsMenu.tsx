import { Download, GitBranch, GitFork, Pencil } from "lucide-react";
import { type RefObject, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import type { SessionActionId } from "../../shared/contracts";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { sessionActions } from "../session-actions";
import { useCopied } from "../use-copied";
import {
  type FloatingMenuConstraints,
  useFloatingMenuDismissal,
  useFloatingMenuPlacement,
} from "../use-floating-menu";
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

const ACTION_ICONS = {
  rename: Pencil,
  clone: GitBranch,
  "switch-branch": GitFork,
  export: Download,
};

export function SessionActionsMenu({
  anchorRef,
  sessionId,
  actionOrder,
  onCopyError,
  cloneDisabled,
  renameDisabled = false,
  onRename,
  onClone,
  onSwitchBranch,
  onExport,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  sessionId: string;
  actionOrder: readonly SessionActionId[];
  onCopyError: (message: string) => void;
  cloneDisabled: boolean;
  renameDisabled?: boolean;
  onRename: () => void;
  onClone: () => void;
  onSwitchBranch: () => void;
  onExport: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { copied, copying, copy } = useCopied({
    scope: sessionId,
    onError: onCopyError,
  });
  const actions: Record<
    SessionActionId,
    { run: () => void; disabled?: boolean }
  > = {
    rename: { run: onRename, disabled: renameDisabled },
    "copy-id": {
      run: () => {
        if (!copying) void copy(sessionId);
      },
    },
    clone: { run: onClone, disabled: cloneDisabled },
    "switch-branch": { run: onSwitchBranch },
    export: { run: onExport },
  };
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
  const placement = useFloatingMenuPlacement(true, resolveTarget, CONSTRAINTS);
  const attachMenu = useCallback((node: HTMLDivElement | null) => {
    menuRef.current = node;
    node
      ?.querySelector<HTMLButtonElement>("button:enabled")
      ?.focus({ preventScroll: true });
  }, []);

  useFloatingMenuDismissal(true, anchorRef, menuRef, onClose);

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
      onKeyDown={(event) => {
        if (isComposingKeyboardEvent(event.nativeEvent)) return;
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
      {actionOrder.map((id) => {
        const Icon = id === "copy-id" ? null : ACTION_ICONS[id];
        const action = actions[id];
        const { title } = sessionActions[id];
        return (
          <button
            key={id}
            type="button"
            role="menuitem"
            data-copied={id === "copy-id" && copied ? "true" : undefined}
            disabled={action.disabled}
            aria-disabled={id === "copy-id" ? copying : undefined}
            onClick={action.run}
          >
            {id === "copy-id" ? (
              <CopyFeedback copied={copied} copying={copying} size={14} />
            ) : Icon ? (
              <Icon size={14} aria-hidden />
            ) : null}
            <ButtonLabel reserve={id === "copy-id" && copied ? title : []}>
              {id === "copy-id" && copied ? "ID copied" : title}
            </ButtonLabel>
          </button>
        );
      })}
      <span className="sr-only" role="status">
        {copied ? "Session ID copied" : ""}
      </span>
    </div>,
    document.body,
  );
}
