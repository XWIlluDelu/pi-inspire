import type { ReactNode } from "react";

export interface SettingsChoice<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/** Fields wrap their control below the label when the available space is too small. */
export function SettingField({
  label,
  description,
  children,
  status,
  className,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  status?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`settings__field${className ? ` ${className}` : ""}`}>
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

/** Keep related feedback together without reserving empty progress rows. */
export function SettingsFeedback({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="settings__feedback" role="group" aria-label={label}>
      {children}
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
    <div className="segmented" role="group" aria-label={label}>
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
  busy = false,
  state,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
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
        aria-busy={busy}
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
