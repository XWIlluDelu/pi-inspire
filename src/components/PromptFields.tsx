import { Eye, EyeOff } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { isComposingKeyboardEvent } from "../keyboard-input";

export function PromptInput({
  title,
  kind = "text",
  initialValue = "",
  placeholder,
  pending,
  required = false,
  submitLabel,
  onSubmit,
  error,
  children,
  inlineLabel = false,
}: {
  title: string;
  kind?: "text" | "secret" | "editor";
  initialValue?: string;
  placeholder?: string;
  pending: boolean;
  required?: boolean;
  submitLabel: string;
  onSubmit: (value: string) => void;
  error?: ReactNode;
  children?: ReactNode;
  inlineLabel?: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState(initialValue);
  const [revealed, setRevealed] = useState(false);
  const field = {
    id,
    "aria-label": title,
    "data-modal-autofocus": true,
    autoFocus: true,
    placeholder,
    disabled: pending,
    value,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setValue(event.target.value),
  };
  const input = (
    <input
      {...field}
      className={inlineLabel ? undefined : "text-field"}
      type={kind === "secret" && !revealed ? "password" : "text"}
      autoComplete="off"
    />
  );
  const submit = (
    <button
      className="button button--primary"
      type="submit"
      disabled={pending || (required && !value)}
    >
      {submitLabel}
    </button>
  );
  return (
    <form
      className={inlineLabel ? "models-login__input" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && (!required || value)) onSubmit(value);
      }}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          isComposingKeyboardEvent(event.nativeEvent)
        )
          event.preventDefault();
      }}
    >
      {inlineLabel ? (
        <label htmlFor={id}>{title}</label>
      ) : (
        <h2 className="dialog__title">{title}</h2>
      )}
      {kind === "editor" ? (
        <textarea {...field} rows={10} className="dialog__editor" />
      ) : kind === "secret" ? (
        <div className="models-secret-input">
          {input}
          <button
            type="button"
            className="models-icon-button"
            aria-label={revealed ? "Hide credential" : "Show credential"}
            aria-pressed={revealed}
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? (
              <EyeOff size={16} aria-hidden />
            ) : (
              <Eye size={16} aria-hidden />
            )}
          </button>
        </div>
      ) : (
        input
      )}
      {error}
      {inlineLabel ? (
        submit
      ) : (
        <div className="dialog__actions">
          {children}
          {submit}
        </div>
      )}
    </form>
  );
}

export function PromptChoices({
  label,
  options,
  pending,
  onChoose,
  children,
}: {
  label: string;
  options: readonly { value: string; label: string; details?: ReactNode }[];
  pending: boolean;
  onChoose: (value: string) => void;
  children?: ReactNode;
}) {
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  return (
    <>
      {children}
      <div
        ref={list}
        className="dialog__options"
        role="listbox"
        aria-label={label}
        onKeyDown={(event) => {
          if (
            pending ||
            !options.length ||
            isComposingKeyboardEvent(event.nativeEvent) ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            !["ArrowDown", "ArrowUp"].includes(event.key) ||
            !(event.target instanceof HTMLButtonElement) ||
            event.target.getAttribute("role") !== "option"
          )
            return;
          event.preventDefault();
          const next =
            (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
            options.length;
          list.current
            ?.querySelectorAll<HTMLButtonElement>("[role=option]")
            [next]?.focus();
        }}
      >
        {options.map((option, index) => (
          <div className="prompt-choice" key={index}>
            <button
              type="button"
              className="picker__row"
              role="option"
              tabIndex={active === index ? 0 : -1}
              aria-selected={active === index}
              disabled={pending}
              onFocus={() => setActive(index)}
              onClick={() => onChoose(option.value)}
            >
              <span className="extension-dialog__choice">{option.label}</span>
            </button>
            {option.details}
          </div>
        ))}
      </div>
    </>
  );
}
