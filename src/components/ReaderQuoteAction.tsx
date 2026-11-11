import { TextQuote } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { formatReaderQuote, readerSelectionLocation } from "../reader-quote";
import { selectionPlainText } from "./rich-text-copy";

type Anchor = { left: number; top: number };

/**
 * One quiet action that exists only while text in the reader is selected. It
 * sits just below the selection's end, clear of the native selection menu on
 * touch, and turns the passage plus its location into a composer quote.
 */
export function ReaderQuoteAction({
  rootRef,
  contentRef,
  source,
  enabled,
  onQuote,
}: {
  rootRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  source: string;
  enabled: boolean;
  onQuote: (markdown: string) => void;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    if (!enabled) {
      setAnchor(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = rootRef.current;
        const content = contentRef.current;
        const selection = window.getSelection();
        if (
          !root ||
          !content ||
          !selection ||
          selection.isCollapsed ||
          selection.rangeCount === 0
        ) {
          setAnchor(null);
          return;
        }
        const range = selection.getRangeAt(0);
        if (
          !content.contains(range.startContainer) ||
          !content.contains(range.endContainer) ||
          !range.toString().trim()
        ) {
          setAnchor(null);
          return;
        }
        const rects = [...range.getClientRects()].filter(
          (rect) => rect.width > 0 || rect.height > 0,
        );
        const end = rects.at(-1) ?? range.getBoundingClientRect();
        const bounds = root.getBoundingClientRect();
        const visible = content.getBoundingClientRect();
        // A selection scrolled out of the reader has nothing to anchor to.
        if (end.bottom < visible.top || end.top > visible.bottom) {
          setAnchor(null);
          return;
        }
        const width = 88;
        const left = Math.min(
          Math.max(end.right - bounds.left - width / 2, 8),
          bounds.width - width - 8,
        );
        const below = end.bottom - bounds.top + 6;
        const top =
          below + 36 > visible.bottom - bounds.top
            ? Math.max(end.top - bounds.top - 36, 4)
            : below;
        setAnchor({ left, top });
      });
    };
    document.addEventListener("selectionchange", measure);
    const content = contentRef.current;
    content?.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", measure);
      content?.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [contentRef, enabled, rootRef]);

  if (!anchor) return null;
  return (
    <button
      type="button"
      className="reader-quote"
      style={{ left: anchor.left, top: anchor.top }}
      title="Quote in message"
      // Keep the document selection alive until the click reads it.
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        const content = contentRef.current;
        const selection = window.getSelection();
        if (!content || !selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const text = selectionPlainText(range, content);
        if (!text.trim()) return;
        onQuote(
          formatReaderQuote(
            text,
            source,
            readerSelectionLocation(range, content),
          ),
        );
        selection.removeAllRanges();
        setAnchor(null);
      }}
    >
      <TextQuote size={14} aria-hidden />
      <span>Quote</span>
    </button>
  );
}
