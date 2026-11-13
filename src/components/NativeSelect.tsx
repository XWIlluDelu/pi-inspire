import type { ComponentProps } from "react";

export function NativeSelect<Value extends string>({
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
  options: readonly { value: Value; label: string; description?: string }[];
  display?: string;
  onChange(value: Value): void;
}) {
  const selected = options.some((option) => option.value === value);
  return (
    <select
      {...props}
      aria-label={label}
      title={props.title ?? label}
      className={`native-select ${className ?? ""}`}
      value={display === undefined && selected ? value : ""}
      onChange={(event) => {
        const value = event.currentTarget.value;
        const choice = options.find((option) => option.value === value);
        if (choice) onChange(choice.value);
      }}
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
