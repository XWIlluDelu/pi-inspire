import type { CSSProperties, ReactNode } from "react";

export interface SettingsChoice<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/** A scalar setting stays inline; wide controls may use the row's full width. */
export function SettingField({
  label,
  description,
  children,
  wide = false,
  status,
  className,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  status?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`settings__field${wide ? " settings__field--wide" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      <div className="settings__field-info">
        <span className="settings__field-label">{label}</span>
        {description ? (
          <p className="settings__field-help">{description}</p>
        ) : null}
        {status ? <div className="settings__field-status">{status}</div> : null}
      </div>
      <div className="settings__field-control">{children}</div>
    </div>
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: SettingsChoice<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="segmented"
      role="group"
      aria-label={label}
      style={{ "--choice-count": options.length } as CSSProperties}
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={`segmented__item${value === option.value ? " segmented__item--active" : ""}`}
          onClick={() => onChange(option.value)}
          disabled={disabled}
          aria-pressed={value === option.value}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export function SettingsSwitch({
  label,
  checked,
  onChange,
  disabled = false,
  state,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  state?: string;
}) {
  return (
    <label className="settings-switch">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="settings-switch__track" aria-hidden>
        <span className="settings-switch__thumb" />
      </span>
      {state ? (
        <span className="settings-switch__state" aria-hidden>
          {state}
        </span>
      ) : null}
    </label>
  );
}
