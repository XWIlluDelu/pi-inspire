import { ListTree } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { currentContentsIndex, ReaderContents } from "./ReaderContents";

const HEADINGS = "h1, h2, h3";
type Entry = { element: HTMLElement; title: string; depth: number };

export function DocumentOutline({
  contentRef,
  identity,
}: {
  contentRef: RefObject<HTMLElement | null>;
  identity: string;
}) {
  const [count, setCount] = useState(0);
  const [contents, setContents] = useState<{
    entries: Entry[];
    current: number;
  } | null>(null);
  useEffect(() => {
    setContents(null);
    const root = contentRef.current;
    if (!root) return;
    const update = () => setCount(root.querySelectorAll(HEADINGS).length);
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [contentRef, identity]);

  if (count < 3) return null;
  return (
    <ReaderContents
      label="Document contents"
      trigger={<ListTree size={16} aria-hidden />}
      open={contents !== null}
      entries={contents?.entries ?? []}
      current={contents?.current ?? -1}
      setOpen={(open) => {
        const root = contentRef.current;
        if (!open || !root) {
          setContents(null);
          return;
        }
        const headings = Array.from(
          root.querySelectorAll<HTMLElement>(HEADINGS),
        );
        const top = Math.min(
          ...headings.map((heading) => Number(heading.tagName[1])),
          3,
        );
        const entries = headings.flatMap((element) => {
          const title = element.textContent?.replace(/\s+/gu, " ").trim();
          return title
            ? [{ element, title, depth: Number(element.tagName[1]) - top }]
            : [];
        });
        const scroller = root.querySelector<HTMLElement>(".res__preview-fill");
        const line = (scroller?.getBoundingClientRect().top ?? 0) + 48;
        setContents({
          entries,
          current: currentContentsIndex(
            entries,
            ({ element }) => element.getBoundingClientRect().top <= line,
          ),
        });
      }}
      onPick={({ element }) => {
        const scroller = element.closest<HTMLElement>(".res__preview-fill");
        if (scroller)
          scroller.scrollTop +=
            element.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            12;
      }}
    />
  );
}
