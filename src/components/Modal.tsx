import { X } from "lucide-react";
import type { ComponentProps, ReactNode, RefObject } from "react";
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
  id,
  bar = true,
  closeLabel,
  onClose,
  disabled,
  children,
}: {
  title: string;
  id?: string;
  bar?: boolean;
  closeLabel?: string;
  onClose?: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <header
      className={bar ? "dialog__header dialog__header--bar" : "dialog__header"}
    >
      <h2 className="dialog__title" id={id}>
        {title}
      </h2>
      {children}
      {onClose && (
        <button
          type="button"
          className="icon-button"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
          disabled={disabled}
        >
          <X size={16} aria-hidden />
        </button>
      )}
    </header>
  );
}

export function ConfirmationDialog({
  id,
  owner,
  title,
  closeLabel,
  description,
  subject,
  warning,
  error,
  confirm,
  busy,
  onClose,
}: {
  id: string;
  owner?: string;
  title: string;
  closeLabel?: string;
  description: ReactNode;
  subject?: ReactNode;
  warning?: ReactNode;
  error?: string | null;
  confirm: {
    label: ReactNode;
    run: () => void;
    primary?: boolean;
    disabled?: boolean;
    busy?: boolean;
  };
  busy?: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      owner={owner}
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description${warning ? ` ${id}-warning` : ""}`}
      onDismiss={busy ? undefined : onClose}
    >
      <div className="dialog">
        <DialogHeader
          title={title}
          id={`${id}-title`}
          bar={false}
          closeLabel={closeLabel}
          onClose={closeLabel ? onClose : undefined}
          disabled={busy}
        />
        {subject}
        <p className="dialog__message" id={`${id}-description`}>
          {description}
        </p>
        {warning && (
          <p className="dialog__warning" id={`${id}-warning`}>
            {warning}
          </p>
        )}
        {error && (
          <p className="dialog__error" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog__actions">
          <button
            type="button"
            className="button button--quiet"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`button ${confirm.primary ? "button--primary" : "button--danger"}`}
            disabled={busy || confirm.disabled}
            aria-busy={confirm.busy}
            onClick={confirm.run}
          >
            {confirm.label}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
