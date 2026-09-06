import { CircleAlert } from "lucide-react";
import { useId, useState } from "react";
import { CopyAction } from "./CopyAction";

/** Pi's message outcome, not a transient notice or collapsible activity. */
export function AssistantError({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const preview = Array.from(text.split("\n").slice(0, 5).join("\n"))
    .slice(0, 400)
    .join("");
  const hasDetails = preview.length < text.length;
  return (
    <div className="assistant-error" role="group" aria-label="PI error">
      <div className="assistant-error__head">
        <CircleAlert size={14} className="assistant-error__icon" aria-hidden />
        <span className="assistant-error__label">PI error</span>
        <CopyAction
          text={text}
          label="Error message"
          className="assistant-error__copy"
        />
      </div>
      <div id={detailsId} className="assistant-error__message">
        {expanded || !hasDetails ? text : `${preview}…`}
      </div>
      {hasDetails ? (
        <button
          type="button"
          className="assistant-error__disclosure"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
      ) : null}
    </div>
  );
}
