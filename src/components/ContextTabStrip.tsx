import { MoreHorizontal } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Dropdown } from "./Dropdown";

interface OverflowTab {
  button: HTMLButtonElement;
  label: string;
  title: string;
}

/** Layout belongs to the shared strip; files and portalled terminal tabs keep
 * their own selection, ordering and lifetime. Hidden tabs remain mounted. */
export function ContextTabStrip({
  children,
  stripRef,
}: {
  children: ReactNode;
  stripRef: RefObject<HTMLDivElement | null>;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<OverflowTab[]>([]);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const strip = stripRef.current;
    const trigger = overflowRef.current;
    if (!shell || !strip || !trigger) return;
    const measure = () => {
      const width = shell.clientWidth;
      if (!width) return;
      const tabs = [...strip.querySelectorAll<HTMLElement>(".ctx__file-tab")];
      // Measure the natural, capped widths before excluding overflow from flex
      // layout. This also covers terminal title changes and inline rename.
      for (const tab of tabs) tab.hidden = false;
      strip.style.removeProperty("--ctx-tab-max");
      trigger.hidden = false;
      const widths = tabs.map((tab) => tab.getBoundingClientRect().width);
      const visible = new Set<HTMLElement>();
      if (widths.reduce((sum, value) => sum + value, 0) <= width) {
        for (const tab of tabs) visible.add(tab);
      } else {
        let remaining = width - trigger.getBoundingClientRect().width;
        const maxWidth = Math.max(132, Math.min(180, remaining));
        strip.style.setProperty("--ctx-tab-max", `${maxWidth}px`);
        for (const [index, value] of widths.entries())
          widths[index] = Math.min(value, maxWidth);
        let active = tabs.findIndex((tab) =>
          tab.classList.contains("ctx__file-tab--active"),
        );
        if (active < 0)
          active = tabs.findIndex((tab) =>
            tab.contains(document.activeElement),
          );
        if (active >= 0) {
          visible.add(tabs[active]!);
          remaining -= widths[active]!;
        }
        for (const [index, tab] of tabs.entries()) {
          if (index === active) continue;
          if (widths[index]! > remaining) break;
          visible.add(tab);
          remaining -= widths[index]!;
        }
      }
      const next: OverflowTab[] = [];
      for (const tab of tabs) {
        tab.hidden = !visible.has(tab);
        const button = tab.querySelector<HTMLButtonElement>('[role="tab"]');
        if (tab.hidden && button)
          next.push({
            button,
            label:
              button.getAttribute("aria-label") ?? button.textContent ?? "",
            title: button.title,
          });
      }
      trigger.hidden = next.length === 0;
      if (!next.length && trigger.contains(document.activeElement))
        strip
          .closest(".ctx__tabs")
          ?.querySelector<HTMLButtonElement>(
            '[role="tab"][aria-selected="true"]',
          )
          ?.focus({ preventScroll: true });
      strip.scrollLeft = 0;
      setOverflow((current) =>
        current.length === next.length &&
        current.every(
          (tab, index) =>
            tab.button === next[index]?.button &&
            tab.label === next[index]?.label &&
            tab.title === next[index]?.title,
        )
          ? current
          : next,
      );
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(shell);
    // Terminal tabs render through a portal and can change without rerendering
    // this component. Ignore our own hidden attributes to avoid observer loops.
    const mutations = new MutationObserver(measure);
    mutations.observe(strip, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "aria-selected", "aria-label", "title"],
    });
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      resize.disconnect();
      mutations.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [stripRef]);

  return (
    <div className="ctx__file-tabs-shell" ref={shellRef}>
      <div className="ctx__file-tabs" ref={stripRef}>
        {children}
      </div>
      <div
        className="ctx__tab-overflow"
        ref={overflowRef}
        hidden={overflow.length === 0}
      >
        {overflow.length > 0 ? (
          <Dropdown
            label="More tabs"
            title="More tabs"
            value=""
            display=""
            indicator={<MoreHorizontal size={16} aria-hidden />}
            options={overflow.map((tab, index) => ({
              value: String(index),
              label: tab.label,
              description: tab.title === tab.label ? undefined : tab.title,
            }))}
            onChange={(value) => {
              const button = overflow[Number(value)]?.button;
              button?.click();
              requestAnimationFrame(() =>
                button?.focus({ preventScroll: true }),
              );
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
