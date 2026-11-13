import type { ComponentProps } from "react";

export function NativeSelect({
  label,
  value,
  options,
  display,
  onChange,
  className,
  ...props
}: Omit<ComponentProps<"select">, "value" | "onChange"> & {
  label: string;
  value: string;
  options: readonly { value: string; label: string; description?: string }[];
  display?: string;
  onChange(value: string): void;
}) {
  const selected = options.some((option) => option.value === value);
  return (
    <select
      {...props}
      aria-label={label}
      title={props.title ?? label}
      className={`native-select ${className ?? ""}`}
      value={display === undefined && selected ? value : ""}
      onChange={(event) => onChange(event.currentTarget.value)}
      data-modal-autofocus={props.autoFocus || undefined}
    >
      {(display !== undefined || !selected) && (
        <option value="" disabled>
          {display ?? value}
        </option>
      )}
      {options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          title={option.description}
        >
          {option.label}
        </option>
      ))}
    </select>
  );
}
