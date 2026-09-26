import { Check, Copy, MessageSquareQuote, TextSelect, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useCopied } from "../use-copied";
import { useModalFocus } from "../use-modal-focus";

export function TerminalTextDialog({
  text,
  scrollRatio,
  onClose,
  onSendToComposer,
}: {
  text: string;
  scrollRatio: number;
  onClose: () => void;
  onSendToComposer?: (value: string) => void;
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(
    true,
    "terminal-text",
    onClose,
  );
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopied({ onError: setError });

  useLayoutEffect(() => {
    const field = textRef.current;
    if (!field) return;
    const updateSelection = () =>
      setHasSelection(field.selectionEnd > field.selectionStart);
    // Native select also tracks touch handles and programmatic selection;
    // React's mouse-based onSelect can miss these on touch devices.
    field.addEventListener("select", updateSelection);
    field.focus({ preventScroll: true });
    field.scrollTop = (field.scrollHeight - field.clientHeight) * scrollRatio;
    return () => field.removeEventListener("select", updateSelection);
  }, [scrollRatio]);

  const selectedText = () => {
    const field = textRef.current;
    return field ? text.slice(field.selectionStart, field.selectionEnd) : "";
  };

  return (
    <div
      className="overlay terminal-text-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog terminal-text-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Select terminal text"
        tabIndex={-1}
      >
        <header className="terminal-text-dialog__header">
          <h2>Select text</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close text selection"
            title="Close text selection"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <textarea
          ref={textRef}
          className="terminal-text-dialog__text"
          aria-label="Terminal output"
          value={text}
          readOnly
          inputMode="none"
          spellCheck={false}
          wrap="soft"
        />
        {error && (
          <p className="terminal-text-dialog__error" role="alert">
            {error}
            <br />
            Use your browser’s Copy action on the selected text.
          </p>
        )}
        <footer
          className="terminal-text-dialog__actions"
          onPointerDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="button"
            onClick={() => {
              textRef.current?.focus({ preventScroll: true });
              textRef.current?.select();
            }}
          >
            <TextSelect size={15} aria-hidden="true" /> Select all
          </button>
          <div className="terminal-text-dialog__copy-actions">
            {onSendToComposer && (
              <button
                type="button"
                className="icon-button"
                aria-label="Send terminal selection to composer"
                title="Add selection to the composer without sending"
                disabled={!hasSelection}
                onClick={() => {
                  const selection = selectedText();
                  if (selection) {
                    onSendToComposer(selection);
                    onClose();
                  }
                }}
              >
                <MessageSquareQuote size={16} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="button terminal-text-dialog__copy"
              aria-label={
                copied ? "Copied" : hasSelection ? "Copy selection" : "Copy all"
              }
              onClick={() => {
                setError(null);
                void copy(selectedText() || text);
              }}
            >
              {copied ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <Copy size={15} aria-hidden="true" />
              )}
              {copied ? "Copied" : hasSelection ? "Copy" : "Copy all"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
