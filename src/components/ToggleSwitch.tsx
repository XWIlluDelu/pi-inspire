export function ToggleSwitch({
  label,
  checked,
  onChange,
  disabled,
  busy,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="settings-switch"
      aria-label={label}
      aria-checked={checked}
      aria-busy={busy}
      aria-disabled={busy || undefined}
      disabled={disabled}
      onClick={busy ? undefined : () => onChange(!checked)}
    />
  );
}
