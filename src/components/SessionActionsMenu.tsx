import { Download, GitBranch, GitFork, Pencil } from "lucide-react";
import type { RefObject } from "react";
import type { SessionActionId } from "../../shared/contracts";
import { sessionActions } from "../session-actions";
import { useCopied } from "../use-copied";
import { ButtonLabel } from "./ButtonLabel";
import { AnchoredPanel } from "./ChoicePanel";
import { CopyFeedback } from "./CopyFeedback";

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
  return (
    <AnchoredPanel
      anchorRef={anchorRef}
      label="Session actions"
      open
      onClose={onClose}
      role="menu"
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
    </AnchoredPanel>
  );
}
