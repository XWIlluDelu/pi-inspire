import { Bell, FileText, MoreHorizontal, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { TerminalDescriptor } from "../../shared/terminal-contracts";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { ChoicePanel } from "./ChoicePanel";
import { OptionList, useOptionList } from "./OptionList";
import { SearchField } from "./SearchField";

interface DocumentTab {
  id: string;
  panel: string;
  label: string;
  title: string;
  selected: boolean;
  select(): void;
  close(): void;
}

export type FileDockTab = DocumentTab & {
  kind: "file";
  reveal(): void;
};

export type TerminalDockTab = DocumentTab & {
  kind: "terminal";
  status: TerminalDescriptor["status"];
  unread: boolean;
  bell: boolean;
  rename?: {
    value: string;
    change(value: string): void;
    commit(): void;
    cancel(): void;
  };
  beginRename(): void;
  move(direction: -1 | 1): void;
  drop(fromId: string, after: boolean): void;
};

type DockTab = FileDockTab | TerminalDockTab;

function tabKey(tab: DockTab) {
  return `${tab.kind}:${tab.id}`;
}

function selector(tab: DockTab) {
  return `[data-dock-tab="${CSS.escape(tabKey(tab))}"]`;
}

function DockTabButton({
  tab,
  onClose,
  drag,
  hidden,
}: {
  tab: DockTab;
  drag: React.RefObject<string | null>;
  hidden: boolean;
  onClose(hadFocus: boolean): void;
}) {
  const terminal = tab.kind === "terminal" ? tab : null;
  const rename = terminal?.rename;
  return (
    <div
      className="dock-tab"
      hidden={hidden}
      data-selected={tab.selected || undefined}
      data-tab-key={tabKey(tab)}
      draggable={Boolean(terminal && !rename)}
      onDragStart={(event) => {
        if (!terminal || rename) return;
        drag.current = terminal.id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", terminal.label);
      }}
      onDragEnd={() => {
        drag.current = null;
      }}
      onDragOver={(event) => {
        if (terminal && drag.current && drag.current !== terminal.id)
          event.preventDefault();
      }}
      onDrop={(event) => {
        if (!terminal || !drag.current || terminal.id === drag.current) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        terminal.drop(
          drag.current,
          event.clientX >= bounds.left + bounds.width / 2,
        );
        drag.current = null;
      }}
      role="presentation"
    >
      {rename ? (
        <input
          className="text-field dock-tab__rename"
          value={rename.value}
          autoFocus
          size={1}
          maxLength={120}
          aria-label="Terminal name"
          onChange={(event) => rename.change(event.target.value)}
          onBlur={rename.commit}
          onKeyDown={(event) => {
            if (isComposingKeyboardEvent(event.nativeEvent)) return;
            event.stopPropagation();
            if (event.key === "Enter") rename.commit();
            else if (event.key === "Escape") rename.cancel();
          }}
        />
      ) : (
        <button
          type="button"
          id={terminal ? `terminal-tab-${terminal.id}` : undefined}
          className="dock-tab__select"
          role="tab"
          aria-selected={tab.selected}
          data-terminal-focus-trigger={terminal ? true : undefined}
          data-dock-tab={tabKey(tab)}
          aria-label={`${tab.label}${terminal?.unread ? ", new output" : ""}${terminal?.bell ? ", bell" : ""}`}
          aria-controls={tab.panel}
          aria-keyshortcuts={
            terminal
              ? "Control+Shift+ArrowLeft Control+Shift+ArrowRight Meta+Shift+ArrowLeft Meta+Shift+ArrowRight"
              : undefined
          }
          tabIndex={tab.selected ? 0 : -1}
          onClick={(event) => {
            if (tab.kind === "file" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              tab.reveal();
            } else tab.select();
          }}
          onDoubleClick={terminal?.beginRename}
          onKeyDown={(event) => {
            if (
              !terminal ||
              isComposingKeyboardEvent(event.nativeEvent) ||
              !event.shiftKey ||
              !(event.ctrlKey || event.metaKey) ||
              (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
            )
              return;
            event.preventDefault();
            terminal.move(event.key === "ArrowRight" ? 1 : -1);
          }}
          title={terminal ? `${tab.label} — ${tab.title}` : tab.title}
        >
          {!terminal ? (
            <FileText size={13} aria-hidden />
          ) : (
            <span
              className={`terminal-tab__status terminal-tab__status--${terminal.status}`}
              aria-hidden
            />
          )}
          <span className="dock-tab__label">{tab.label}</span>
          {terminal?.bell && (
            <Bell className="terminal-tab__bell" size={10} aria-hidden />
          )}
          {terminal?.unread && (
            <span className="terminal-tab__unread" aria-hidden />
          )}
        </button>
      )}
      <button
        type="button"
        className="icon-button dock-tab__close"
        aria-label={`Close ${tab.label}`}
        title={terminal ? "Close terminal" : `Close ${tab.label}`}
        onClick={(event) =>
          onClose(document.activeElement === event.currentTarget)
        }
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}

export function ContextTabStrip({
  tabs,
  collapseOverflow,
}: {
  tabs: readonly DockTab[];
  collapseOverflow: boolean;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const drag = useRef<string | null>(null);
  const [overflow, setOverflow] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const list = useOptionList<DockTab>();
  const selected = tabs.find((tab) => tab.selected);
  const activeSelector = selected ? selector(selected) : null;
  const focusTab = (target: string) =>
    requestAnimationFrame(() =>
      stripRef.current
        ?.closest('[role="tablist"]')
        ?.querySelector<HTMLElement>(target)
        ?.focus(),
    );
  // Measure from the shared fixed tab width. Hidden tabs keep their owner and
  // become visible as soon as a user selects them from overflow.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const strip = stripRef.current;
    if (!shell || !strip) return;
    const measure = () => {
      const first = strip.querySelector<HTMLElement>(".dock-tab:not([hidden])");
      const width = first?.getBoundingClientRect().width || 156;
      const total = shell.clientWidth;
      if (
        !collapseOverflow ||
        !total ||
        tabs.length * (width + 2) - 2 <= total
      ) {
        setOverflow((current) => (current.length ? [] : current));
        return;
      }
      const visibleCount = Math.max(1, Math.floor((total - 34) / (width + 2)));
      const keep = new Set(tabs.slice(0, visibleCount).map(tabKey));
      if (selected && !keep.has(tabKey(selected))) {
        const evicted = tabs[visibleCount - 1];
        if (evicted) keep.delete(tabKey(evicted));
        keep.add(tabKey(selected));
      }
      const next = tabs.filter((tab) => !keep.has(tabKey(tab))).map(tabKey);
      const focused =
        document.activeElement?.closest<HTMLElement>("[data-tab-key]");
      if (focused?.dataset.tabKey && next.includes(focused.dataset.tabKey))
        requestAnimationFrame(() => {
          if (
            !document.activeElement ||
            document.activeElement === document.body ||
            document.activeElement === focused
          )
            menuTrigger.current?.focus();
        });
      setOverflow((current) =>
        current.length === next.length &&
        current.every((id, index) => id === next[index])
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [collapseOverflow, selected, tabs]);

  useLayoutEffect(() => {
    if (!collapseOverflow && activeSelector)
      stripRef.current
        ?.querySelector(activeSelector)
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeSelector, collapseOverflow]);
  if (!tabs.length) return null;
  const filter = query.trim().toLocaleLowerCase();
  const options = tabs
    .filter((tab) => overflow.includes(tabKey(tab)))
    .filter((tab) =>
      `${tab.label} ${tab.title}`.toLocaleLowerCase().includes(filter),
    )
    .map((tab) => ({
      key: tabKey(tab),
      value: tab,
      selected: tab.selected,
      title: tab.title,
      label: tab.label,
    }));
  const setMenuOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
      list.reset();
    }
  };
  const pick = (tab: DockTab) => {
    tab.select();
    setMenuOpen(false);
    focusTab(selector(tab));
  };
  return (
    <div
      className="dock-tabs"
      ref={shellRef}
      data-collapse-overflow={collapseOverflow || undefined}
    >
      <div className="dock-tabs__scroll" ref={stripRef}>
        {tabs.map((tab) => (
          <DockTabButton
            key={tabKey(tab)}
            tab={tab}
            drag={drag}
            hidden={overflow.includes(tabKey(tab)) && !tab.selected}
            onClose={(hadFocus) => {
              tab.close();
              if (tab.kind === "file" && hadFocus)
                focusTab('[role="tab"][aria-selected="true"]');
            }}
          />
        ))}
      </div>
      {overflow.length > 0 && (
        <ChoicePanel
          label="More tabs"
          triggerRef={menuTrigger}
          open={open}
          setOpen={setMenuOpen}
          trigger={<MoreHorizontal size={16} aria-hidden />}
        >
          <SearchField
            aria-label="Find open tab"
            placeholder="Find open tab"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={list.id}
            aria-activedescendant={list.descendant(options)}
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              list.reset(true);
            }}
            onKeyDown={(event) =>
              list.navigate(event, options, pick, { edges: true })
            }
          />
          <OptionList
            list={list}
            options={options}
            label="Open tabs"
            onPick={pick}
            optionButtons
            plain
            optionClass="dock-tab-option"
            renderOption={({ value: tab }) => (
              <>
                {tab.label}
                {tab.title !== tab.label && <small>{tab.title}</small>}
              </>
            )}
          >
            {!options.length && <p role="status">No matching tabs</p>}
          </OptionList>
        </ChoicePanel>
      )}
    </div>
  );
}
