import { Bell, FileText, MoreHorizontal, X } from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TerminalDescriptor } from "../../shared/terminal-contracts";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { ChoicePanel } from "./ChoicePanel";

interface DocumentTab {
  id: string;
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
  open: boolean;
  unread: boolean;
  bell: boolean;
  rename?: {
    value: string;
    change(value: string): void;
    commit(): void;
    cancel(): void;
  };
  beginRename(): void;
  keyDown(event: KeyboardEvent<HTMLButtonElement>): void;
  drag(): void;
  drop(event: DragEvent<HTMLDivElement>): void;
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
  focused,
  onClose,
}: {
  tab: DockTab;
  focused: boolean;
  onClose(event: MouseEvent<HTMLButtonElement>): void;
}) {
  const terminal = tab.kind === "terminal" ? tab : null;
  const rename = terminal?.rename;
  return (
    <div
      className="dock-tab"
      data-selected={tab.selected || undefined}
      role={terminal ? "presentation" : undefined}
      draggable={Boolean(terminal)}
      onDragStart={terminal?.drag}
      onDragOver={terminal ? (event) => event.preventDefault() : undefined}
      onDrop={terminal?.drop}
    >
      {rename ? (
        <input
          className="inline-rename-input dock-tab__rename"
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
          {...(focused
            ? { "aria-pressed": tab.selected }
            : { role: "tab" as const, "aria-selected": tab.selected })}
          data-terminal-focus-trigger={terminal ? true : undefined}
          data-dock-tab={tabKey(tab)}
          aria-label={`${tab.label}${terminal?.unread ? ", new output" : ""}${terminal?.bell ? ", bell" : ""}`}
          aria-controls={
            !terminal
              ? "context-file-content"
              : !focused
                ? "context-terminal-content"
                : terminal.open
                  ? `terminal-view-${terminal.id}`
                  : undefined
          }
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
          onKeyDown={terminal?.keyDown}
          title={terminal ? `${tab.label} — ${tab.title}` : tab.title}
        >
          {!terminal ? (
            <FileText size={13} aria-hidden />
          ) : (
            <span className="dock-tab__icon" aria-hidden>
              <span
                className={`terminal-tab__status terminal-tab__status--${terminal.status}`}
              />
            </span>
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
        onClick={onClose}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}

export function ContextTabStrip({
  tabs,
  focused = false,
  active = true,
}: {
  tabs: readonly DockTab[];
  focused?: boolean;
  active?: boolean;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = tabs.find((tab) => tab.selected);
  const activeSelector = selected ? selector(selected) : null;
  const focusTab = (target: string) =>
    requestAnimationFrame(() =>
      stripRef.current
        ?.closest(".ctx__tabs")
        ?.querySelector<HTMLElement>(target)
        ?.focus(),
    );
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || !active || !activeSelector) return;
    const reveal = () =>
      strip
        .querySelector(activeSelector)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [active, activeSelector]);
  const strip = (
    <div
      className="dock-tabs__scroll"
      {...(focused
        ? { role: "toolbar" as const, "aria-label": "Project terminals" }
        : {})}
      ref={stripRef}
    >
      {tabs.map((tab) => (
        <DockTabButton
          key={tabKey(tab)}
          tab={tab}
          focused={focused}
          onClose={(event) => {
            const restoreFocus =
              tab.kind === "file" &&
              document.activeElement === event.currentTarget;
            tab.close();
            if (restoreFocus) focusTab('[role="tab"][aria-selected="true"]');
          }}
        />
      ))}
    </div>
  );
  if (focused) return strip;
  const filter = query.trim().toLocaleLowerCase();
  const matching = tabs.filter((tab) =>
    `${tab.label} ${tab.title}`.toLocaleLowerCase().includes(filter),
  );
  const setMenuOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  return (
    <div className="dock-tabs">
      {strip}
      {tabs.length > 1 && (
        <div className="ctx__tab-overflow">
          <ChoicePanel
            label="Open tabs"
            open={open}
            setOpen={setMenuOpen}
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
                  key={tabKey(tab)}
                  type="button"
                  aria-current={tab.selected || undefined}
                  title={tab.title}
                  onClick={() => {
                    tab.select();
                    setMenuOpen(false);
                    focusTab(selector(tab));
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
