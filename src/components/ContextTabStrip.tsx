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
}: {
  tab: DockTab;
  onClose(hadFocus: boolean): void;
}) {
  const terminal = tab.kind === "terminal" ? tab : null;
  const rename = terminal?.rename;
  return (
    <div
      className="dock-tab"
      data-selected={tab.selected || undefined}
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

export function ContextTabStrip({ tabs }: { tabs: readonly DockTab[] }) {
  const stripRef = useRef<HTMLDivElement>(null);
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
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activeSelector) return;
    const reveal = () =>
      strip
        .querySelector(activeSelector)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [activeSelector]);
  if (!tabs.length) return null;
  const filter = query.trim().toLocaleLowerCase();
  const options = tabs
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
    <div className="dock-tabs">
      <div className="dock-tabs__scroll" ref={stripRef}>
        {tabs.map((tab) => (
          <DockTabButton
            key={tabKey(tab)}
            tab={tab}
            onClose={(hadFocus) => {
              tab.close();
              if (tab.kind === "file" && hadFocus)
                focusTab('[role="tab"][aria-selected="true"]');
            }}
          />
        ))}
      </div>
      {tabs.length > 1 && (
        <ChoicePanel
          label="Open tabs"
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
