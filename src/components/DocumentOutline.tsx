import { ListTree } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const HEADINGS = "h1, h2, h3";
/** Short documents navigate fine by scrolling; the control appears only when
 * an outline actually saves effort. */
export const DOCUMENT_OUTLINE_MIN_HEADINGS = 3;

type Entry = { element: HTMLElement; title: string; depth: number };

function collect(root: HTMLElement): Entry[] {
  const headings = [...root.querySelectorAll<HTMLElement>(HEADINGS)];
  const top = Math.min(...headings.map((h) => Number(h.tagName[1])), 3);
  return headings.flatMap((element) => {
    const title = element.textContent?.replace(/\s+/gu, " ").trim();
    return title
      ? [{ element, title, depth: Number(element.tagName[1]) - top }]
      : [];
  });
}

/** Count headings as progressive rendering fills the reader. */
export function useDocumentHeadingCount(
  contentRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  identity: unknown,
): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const root = contentRef.current;
    if (!enabled || !root) {
      setCount(0);
      return;
    }
    const update = () => setCount(root.querySelectorAll(HEADINGS).length);
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [contentRef, enabled, identity]);
  return count;
}

/** Contents for a rendered Markdown or notebook document. Opening it reads the
 * current headings; choosing one scrolls only the reader's own scroller. */
export function DocumentOutlineButton({
  contentRef,
  portalRef,
}: {
  contentRef: RefObject<HTMLElement | null>;
  portalRef: RefObject<HTMLElement | null>;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [current, setCurrent] = useState(-1);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const open = entries !== null;

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLButtonElement>('[aria-current="location"], button')
        ?.focus(),
    );
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !listRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      )
        setEntries(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open]);

  const toggle = () => {
    const root = contentRef.current;
    if (open || !root) {
      setEntries(null);
      return;
    }
    const found = collect(root);
    const scroller = root.querySelector<HTMLElement>(".res__preview-fill");
    const line = (scroller?.getBoundingClientRect().top ?? 0) + 48;
    let active = -1;
    found.forEach((entry, index) => {
      if (entry.element.getBoundingClientRect().top <= line) active = index;
    });
    setCurrent(active);
    setEntries(found);
  };

  const jump = (entry: Entry) => {
    setEntries(null);
    const scroller = entry.element.closest<HTMLElement>(".res__preview-fill");
    if (scroller) {
      const offset =
        entry.element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top;
      scroller.scrollTop += offset - 12;
    }
    buttonRef.current?.focus({ preventScroll: true });
  };

  const list =
    open && portalRef.current ? (
      <nav
        ref={listRef}
        className="reader-contents reader-contents--document"
        aria-label="Document contents"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setEntries(null);
            buttonRef.current?.focus();
          }
        }}
      >
        {entries.map((entry, index) => (
          <button
            key={index}
            type="button"
            className="reader-contents__entry"
            style={{ paddingInlineStart: `${12 + entry.depth * 14}px` }}
            aria-current={index === current ? "location" : undefined}
            onClick={() => jump(entry)}
          >
            <span>{entry.title}</span>
          </button>
        ))}
      </nav>
    ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-button"
        aria-label="Document contents"
        title="Contents"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
      >
        <ListTree size={16} aria-hidden />
      </button>
      {list && portalRef.current ? createPortal(list, portalRef.current) : null}
    </>
  );
}
