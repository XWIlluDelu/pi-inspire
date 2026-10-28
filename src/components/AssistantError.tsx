import { ChevronDown, CircleAlert, Square } from "lucide-react";
import { useContext, useId, useLayoutEffect, useState } from "react";
import { CopyAction } from "./CopyAction";
import { TranscriptSearchReveal } from "./transcript-search";

/** Cancellation keeps the outcome header, without diagnostics or actions. */
export function AssistantStopped() {
  return (
    <div
      className="assistant-error assistant-error--stopped"
      role="group"
      aria-label="Stopped"
    >
      <div className="assistant-error__head">
        <Square size={14} className="assistant-error__icon" aria-hidden />
        <span className="assistant-error__label">Stopped</span>
      </div>
    </div>
  );
}

/** Pi's message outcome, not a transient notice or collapsible activity. */
export function AssistantError({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const paragraphBreak = /\n\s*\n/.exec(text);
  const firstParagraph =
    paragraphBreak &&
    paragraphBreak.index > 0 &&
    paragraphBreak.index + paragraphBreak[0].length < text.length
      ? text.slice(0, paragraphBreak.index)
      : text;
  const diagnostics =
    firstParagraph !== text && paragraphBreak
      ? text.slice(paragraphBreak.index + paragraphBreak[0].length)
      : "";
  const searchReveal = useContext(TranscriptSearchReveal);
  useLayoutEffect(() => {
    if (searchReveal !== null) setExpanded(true);
  }, [searchReveal]);
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
        <span className="assistant-error__reason">
          {expanded || !hasDetails
            ? firstParagraph
            : `${preview}${preview.length < firstParagraph.length ? "…" : ""}`}
        </span>
        {expanded && diagnostics ? (
          <>
            {paragraphBreak![0]}
            <pre className="assistant-error__diagnostics">{diagnostics}</pre>
          </>
        ) : null}
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
          <span>{expanded ? "Hide details" : "Show details"}</span>
        </button>
      ) : null}
    </div>
  );
}
