import type { RefObject } from "react";
import {
  runSessionAction,
  sessionActionAvailable,
  sessionActions,
} from "../session-actions";
import { shallowEqual, store, useAppState } from "../store";
import { useCopied } from "../use-copied";
import { ButtonLabel } from "./ButtonLabel";
import { AnchoredPanel } from "./ChoicePanel";
import { CopyFeedback } from "./CopyFeedback";

export function SessionActionsMenu({
  anchorRef,
  sessionId,
  onRename,
  onExport,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  sessionId: string;
  onRename: (sessionId: string, name: string) => void;
  onExport: () => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const { order, rename, clone } = useAppState(
    (state) => ({
      order: state.prefs.sessionActionOrder,
      rename: sessionActionAvailable("rename", state),
      clone: sessionActionAvailable("clone", state),
    }),
    shallowEqual,
  );
  const { copied, copying, copy } = useCopied({
    scope: sessionId,
    onError: store.reportCopyError,
  });
  return (
    <AnchoredPanel
      anchorRef={anchorRef}
      label="Session actions"
      open
      onClose={onClose}
      role="menu"
    >
      {order.map((id) => {
        const { icon: Icon, title } = sessionActions[id];
        const copyId = id === "copy-id";
        return (
          <button
            key={id}
            type="button"
            role="menuitem"
            disabled={id === "rename" ? !rename : id === "clone" && !clone}
            aria-disabled={copyId ? copying : undefined}
            onClick={() =>
              runSessionAction(id, sessionId, {
                copyId: () => {
                  if (!copying) void copy(sessionId, store.copyOwnership());
                },
                rename: onRename,
                export: onExport,
                closeMenu: onClose,
              })
            }
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
        );
      })}
      <span className="sr-only" role="status">
        {copied ? "Session ID copied" : ""}
      </span>
    </AnchoredPanel>
  );
}
