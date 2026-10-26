import { Search, X } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type Ref,
  useImperativeHandle,
  useRef,
} from "react";
import { PiLoader } from "./PiLoader";

type SearchFieldProps = Omit<
  ComponentPropsWithoutRef<"input">,
  "type" | "value" | "defaultValue" | "onChange" | "children"
> & {
  inputRef?: Ref<HTMLInputElement>;
  value: string;
  onValueChange: (value: string) => void;
  clearLabel: string;
  iconSize?: number;
  loading?: boolean;
  loadingLabel?: string;
};

/** Shared clearing and feedback; each search owns its keyboard and query rules. */
export function SearchField({
  inputRef,
  value,
  onValueChange,
  clearLabel,
  className = "",
  iconSize = 14,
  loading = false,
  loadingLabel,
  ...inputProps
}: SearchFieldProps) {
  const fieldRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(inputRef, () => fieldRef.current!, []);
  return (
    <div
      className={`search-field ${className}`}
      onClick={(event) => {
        if (
          event.target === event.currentTarget ||
          (event.target instanceof Element &&
            event.target.closest(".search-field__icon"))
        )
          fieldRef.current?.focus();
      }}
    >
      <span className="search-field__icon">
        {loading ? (
          <PiLoader size={iconSize} aria-label={loadingLabel} />
        ) : (
          <Search size={iconSize} aria-hidden />
        )}
      </span>
      <input
        {...inputProps}
        ref={fieldRef}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="search-field__clear"
          aria-label={clearLabel}
          title="Clear search"
          disabled={inputProps.disabled || inputProps.readOnly}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onValueChange("");
            fieldRef.current?.focus({ preventScroll: true });
          }}
        >
          <X size={12} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
