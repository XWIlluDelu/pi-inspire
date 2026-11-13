import { MoreHorizontal } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useState,
} from "react";
import { ChoicePanel } from "./ChoicePanel";

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
  const [open, setOpen] = useState(false);
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
          <ChoicePanel
            label="Open tabs"
            open={open}
            setOpen={(next) => {
              setOpen(next);
              if (!next) setQuery("");
            }}
            trigger={<MoreHorizontal size={16} aria-hidden />}
            className="ctx__open-tabs-menu"
          >
            <input
              aria-label="Find open tab"
              placeholder="Find open tab"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  event.currentTarget.nextElementSibling
                    ?.querySelector("button")
                    ?.focus();
                }
              }}
            />
            <div className="ctx__open-tab-results">
              {matching.length === 0 && <p>No matching tabs</p>}
              {matching.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  aria-current={tab.selected || undefined}
                  title={tab.title}
                  onClick={() => {
                    tab.select();
                    setOpen(false);
                    setQuery("");
                    requestAnimationFrame(() =>
                      stripRef.current
                        ?.querySelector<HTMLElement>(selector(tab.id))
                        ?.focus(),
                    );
                  }}
                >
                  {tab.label}
                  {tab.title !== tab.label && <small>{tab.title}</small>}
                </button>
              ))}
            </div>
          </ChoicePanel>
        </div>
      )}
    </div>
  );
}
