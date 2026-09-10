import { Eye, EyeOff } from "lucide-react";

export function HiddenFilesToggle({
  showHidden,
  onChange,
}: {
  showHidden: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label="Show hidden files"
      title="Show hidden files"
      aria-pressed={showHidden}
      onClick={() => onChange(!showHidden)}
    >
      {showHidden ? (
        <Eye size={14} aria-hidden />
      ) : (
        <EyeOff size={14} aria-hidden />
      )}
    </button>
  );
}
