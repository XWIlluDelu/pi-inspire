import { X } from "lucide-react";
import type { ComponentProps, RefObject } from "react";
import { useDialog } from "../use-modal-focus";

/** The panel keeps its own layout; the browser owns the surrounding top layer. */
export function Modal({
  active = true,
  ref: dialogRef,
  owner,
  focusSurface = false,
  overlayClassName,
  onDismiss,
  onEscape = onDismiss,
  children,
  ...props
}: Pick<
  ComponentProps<"dialog">,
  | "role"
  | "aria-label"
  | "aria-labelledby"
  | "aria-describedby"
  | "aria-busy"
  | "children"
  | "onKeyDown"
> & {
  ref?: RefObject<HTMLDialogElement | null>;
  active?: boolean;
  owner?: unknown;
  focusSurface?: boolean;
  overlayClassName?: string;
  onDismiss?: () => void;
  onEscape?: () => boolean | void;
}) {
  const ref = useDialog(active, owner, onEscape, dialogRef);
  return (
    <dialog
      {...props}
      ref={ref}
      aria-modal="true"
      className={`overlay${overlayClassName ? ` ${overlayClassName}` : ""}`}
      data-modal-autofocus={focusSurface || undefined}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onEscape?.();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss?.();
      }}
    >
      {children}
    </dialog>
  );
}

export function DialogHeader({
  title,
  closeLabel,
  onClose,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <header className="dialog__header dialog__header--bar">
      <h2 className="dialog__title">{title}</h2>
      <button
        type="button"
        className="icon-button"
        aria-label={closeLabel}
        title={closeLabel}
        onClick={onClose}
      >
        <X size={16} aria-hidden />
      </button>
    </header>
  );
}
