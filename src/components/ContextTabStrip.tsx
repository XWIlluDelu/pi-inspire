import { MoreHorizontal } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useState,
} from "react";
import { Dropdown } from "./Dropdown";

interface DockTab {
  id: string;
  label: string;
  title: string;
  selected: boolean;
  select(): void;
}

function selector(id: string) {
  return `[data-dock-tab="${CSS.escape(id)}"]`;
}

export function ContextTabStrip({
  children,
  stripRef,
  tabs,
}: {
  children: ReactNode;
  stripRef: RefObject<HTMLDivElement | null>;
  tabs: readonly DockTab[];
}) {
  const [query, setQuery] = useState("");
  const active = tabs.find((tab) => tab.selected)?.id;
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || !active) return;
    const reveal = () =>
      strip
        .querySelector(selector(active))
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [active, stripRef]);
  const matching = tabs.filter((tab) =>
    `${tab.label} ${tab.title}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <div className="ctx__file-tabs-shell">
      <div className="ctx__file-tabs" ref={stripRef}>
        {children}
      </div>
      {tabs.length > 1 && (
        <div className="ctx__tab-overflow">
          <Dropdown
            label="Open tabs"
            title="Open tabs"
            value={active ?? ""}
            emptyText="No matching tabs"
            selectCurrent
            menuClassName="ctx__open-tabs-menu"
            display=""
            indicator={<MoreHorizontal size={16} aria-hidden />}
            header={
              <input
                aria-label="Find open tab"
                placeholder="Find open tab"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            }
            options={matching.map(({ id, label, title }) => ({
              value: id,
              label,
              description: title === label ? undefined : title,
            }))}
            onChange={(id) => {
              tabs.find((tab) => tab.id === id)?.select();
              setQuery("");
              requestAnimationFrame(() =>
                stripRef.current
                  ?.querySelector<HTMLElement>(selector(id))
                  ?.focus(),
              );
            }}
          />
        </div>
      )}
    </div>
  );
}
