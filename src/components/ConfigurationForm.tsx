import {
  ArrowLeft,
  Eye,
  EyeOff,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  type MouseEventHandler,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ConfigurationControl,
  SecretEdit,
} from "../../shared/configuration-fields";
import { ButtonLabel } from "./ButtonLabel";

/** One declaration detail is mounted for the selected identity. */
export function ConfigurationDetail({
  label,
  children,
  edit,
  remove,
  disabled,
  extra,
}: {
  label: string;
  children: ReactNode;
  edit?: MouseEventHandler<HTMLButtonElement>;
  remove: MouseEventHandler<HTMLButtonElement>;
  disabled: boolean;
  extra?: ReactNode;
}) {
  const actions = [
    { name: "Edit", Icon: Pencil, run: edit },
    { name: "Remove", Icon: Trash2, run: remove },
  ];
  return (
    <div className="models-detail" role="group" aria-label={label}>
      {children}
      <div className="models-actions">
        {actions.map(({ name, Icon, run }) => (
          <button
            key={name}
            type="button"
            className="models-icon-button"
            aria-label={`${name} ${label}`}
            title={`${name} ${label}`}
            disabled={disabled || !run}
            onClick={run}
          >
            <Icon size={14} aria-hidden />
          </button>
        ))}
        {extra}
      </div>
    </div>
  );
}

export function ConfigurationRefresh({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="models-icon-button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={onClick}
    >
      <RefreshCw size={14} aria-hidden />
    </button>
  );
}

export function ConfigurationEditor({
  title,
  identity,
  backLabel,
  busy,
  onClose,
  refresh,
  children,
}: {
  title: string;
  identity?: string;
  backLabel: string;
  busy: boolean;
  onClose: () => void;
  refresh: { label: string; run: () => void };
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      className="models-editor models-settings"
      aria-labelledby={titleId}
    >
      <header className="models-editor__header">
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={onClose}
        >
          <ArrowLeft size={14} aria-hidden /> {backLabel}
        </button>
        <div className="models-subheading">
          <div>
            <h3 id={titleId}>{title}</h3>
            {identity && <code>{identity}</code>}
          </div>
          <ConfigurationRefresh
            label={refresh.label}
            busy={busy}
            onClick={refresh.run}
          />
        </div>
      </header>
      {children}
    </section>
  );
}

export function ConfigurationRemoval({
  children,
  busy,
  blocked,
  onRemove,
  onCancel,
}: {
  children: ReactNode;
  busy: boolean;
  blocked?: boolean;
  onRemove: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="models-confirm"
      role="group"
      aria-label="Remove configuration"
    >
      <p>{children}</p>
      <div className="models-actions">
        <button
          type="button"
          className="button button--danger"
          disabled={busy || blocked}
          onClick={onRemove}
        >
          Remove configuration
        </button>
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function revealField(body: HTMLDivElement, input: Element | null) {
  if (!(input instanceof HTMLElement)) return;
  const field = input.closest<HTMLElement>("label, .models-form__field");
  if (!field) return;
  // Native autofocus scrolls the input before the editor finishes sizing.
  // Reveal its label after layout, without taking focus back from another owner.
  requestAnimationFrame(() => {
    if (!body.contains(input) || input.ownerDocument.activeElement !== input)
      return;
    const viewport = body.closest<HTMLElement>(".settings__content");
    const style = viewport && getComputedStyle(viewport);
    const available = Math.min(
      body.clientHeight,
      viewport && style
        ? viewport.clientHeight -
            (Number.parseFloat(style.scrollPaddingTop) || 0) -
            (Number.parseFloat(style.scrollPaddingBottom) || 0)
        : body.clientHeight,
    );
    // A tall textarea can exceed the viewport; retain native caret scrolling.
    if (available <= 0 || field.getBoundingClientRect().height > available)
      return;
    field.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
  });
}

export function ConfigurationForm({
  children,
  busy,
  saveDisabled,
  pendingLabel,
  error,
  onSave,
  onCancel,
  inline = false,
}: {
  children: ReactNode;
  busy: boolean;
  saveDisabled: boolean;
  pendingLabel?: string;
  error?: string | null;
  onSave: () => void;
  onCancel: () => void;
  inline?: boolean;
}) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      revealField(element, element.ownerDocument.activeElement),
    );
    observer.observe(element);
    const viewport = element.closest(".settings__content");
    if (viewport) observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  return (
    <form
      className={inline ? "models-common__editor" : "models-form"}
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div
        ref={body}
        className={inline ? undefined : "models-form__body"}
        onFocusCapture={(event) =>
          revealField(event.currentTarget, event.target)
        }
      >
        {children}
        {error && (
          <p className="settings__error" role="alert" tabIndex={-1}>
            {error}
          </p>
        )}
      </div>
      <div
        className={
          inline ? "models-actions" : "models-actions models-form__actions"
        }
      >
        <button
          type="submit"
          className={inline ? "button" : "button button--primary"}
          disabled={busy || saveDisabled}
        >
          {pendingLabel ? (
            <ButtonLabel reserve={pendingLabel}>
              {busy ? pendingLabel : "Save"}
            </ButtonLabel>
          ) : (
            "Save"
          )}
        </button>
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ConfigurationInput({
  label,
  wide,
  after,
  ...props
}: ComponentProps<"input"> & {
  label: string;
  wide?: boolean;
  after?: ReactNode;
}) {
  return (
    <label className={wide ? "models-form__wide" : undefined}>
      {label}
      {after ? (
        <div className="models-secret-input">
          <input {...props} />
          {after}
        </div>
      ) : (
        <input {...props} />
      )}
    </label>
  );
}

/** A blank protected input keeps its stored value. Null is an explicit removal. */
export function ProtectedConfigurationInput({
  control,
  value,
  stored,
  busy,
  showValue,
  onChange,
}: {
  control: ConfigurationControl;
  value: string | number | null | undefined;
  stored?: boolean;
  busy: boolean;
  showValue?: true;
  onChange: (edit: SecretEdit<string | number>) => void;
}) {
  const [show, setShow] = useState(false);
  const { label, wide, type, ...input } = control;
  const Icon = show ? EyeOff : Eye;
  return (
    <div className={wide ? "models-form__wide" : "models-form__field"}>
      <ConfigurationInput
        {...input}
        label={label}
        type={show ? "text" : type}
        value={value ?? ""}
        autoComplete="new-password"
        disabled={busy || value === null}
        placeholder={stored ? "Stored · leave blank to keep" : "Optional"}
        onChange={({ currentTarget: field }) =>
          onChange(
            field.value
              ? {
                  kind: "replace",
                  value: type === "number" ? field.valueAsNumber : field.value,
                }
              : { kind: "keep" },
          )
        }
        after={
          showValue && (
            <button
              type="button"
              className="models-icon-button"
              disabled={busy || value === null}
              aria-label={`${show ? "Hide" : "Show"} ${label}`}
              aria-pressed={show}
              onClick={() => setShow(!show)}
            >
              <Icon size={16} aria-hidden />
            </button>
          )
        }
      />
      {stored && (
        <label className="models-checkbox">
          <input
            type="checkbox"
            className="choice-input"
            disabled={busy || (showValue && Boolean(value))}
            checked={value === null}
            onChange={(event) =>
              onChange({ kind: event.target.checked ? "remove" : "keep" })
            }
          />
          Remove {showValue ? label : label.toLowerCase()}
        </label>
      )}
    </div>
  );
}
