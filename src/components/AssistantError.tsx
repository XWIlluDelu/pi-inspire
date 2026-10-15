import { ChevronDown, CircleAlert } from "lucide-react";
import { useId, useState } from "react";
import { CopyAction } from "./CopyAction";

/** Pi's message outcome, not a transient notice or collapsible activity. */
export function AssistantError({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const firstParagraph = text.split(/\n\s*\n/)[0] || text;
  const preview = Array.from(firstParagraph.split("\n").slice(0, 3).join("\n"))
    .slice(0, 240)
    .join("");
  const hasDetails = preview.length < text.length;
  return (
    <div className="assistant-error" role="group" aria-label="Pi error">
      <div className="assistant-error__head">
        <CircleAlert size={14} className="assistant-error__icon" aria-hidden />
        <span className="assistant-error__label">Pi error</span>
        <CopyAction
          text={text}
          label="Error message"
          className="assistant-error__copy"
        />
      </div>
      <section
        id={detailsId}
        aria-label={expanded ? "Error details" : undefined}
        tabIndex={expanded ? 0 : undefined}
        className={`assistant-error__message${expanded ? " assistant-error__message--expanded" : ""}`}
      >
        {expanded || !hasDetails
          ? text
          : `${preview}${preview.length < firstParagraph.length ? "…" : ""}`}
      </section>
      {hasDetails ? (
        <button
          type="button"
          className="assistant-error__disclosure"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDown size={12} aria-hidden />
          {expanded ? "Hide details" : "Show details"}
        </button>
      ) : null}
    </div>
  );
}
