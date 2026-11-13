import { Bell, X } from "lucide-react";
import type { DragEvent, KeyboardEvent } from "react";
import type { TerminalDescriptor } from "../../shared/terminal-contracts";
import { isComposingKeyboardEvent } from "../keyboard-input";

export interface TerminalTab {
  id: string;
  label: string;
  title: string;
  status: TerminalDescriptor["status"];
  selected: boolean;
  open: boolean;
  unread: boolean;
  bell: boolean;
  rename?: {
    value: string;
    change(value: string): void;
    commit(): void;
    cancel(): void;
  };
  select(): void;
  beginRename(): void;
  close(): void;
  keyDown(event: KeyboardEvent<HTMLButtonElement>): void;
  drag(): void;
  drop(event: DragEvent<HTMLDivElement>): void;
}

export function TerminalTabs({
  tabs,
  sharedTabs = false,
}: {
  tabs: readonly TerminalTab[];
  sharedTabs?: boolean;
}) {
  return (
    <div
      className={
        sharedTabs ? "terminal-tabs terminal-tabs--shared" : "terminal-tabs"
      }
      {...(!sharedTabs
        ? { role: "toolbar" as const, "aria-label": "Project terminals" }
        : {})}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={
            sharedTabs
              ? `ctx__file-tab${tab.selected ? " ctx__file-tab--active" : ""}`
              : `terminal-tab${tab.selected ? " terminal-tab--active" : ""}`
          }
          role="presentation"
          draggable
          onDragStart={tab.drag}
          onDragOver={(event) => event.preventDefault()}
          onDrop={tab.drop}
        >
          {tab.rename ? (
            <input
              className="inline-rename-input terminal-tab__rename"
              value={tab.rename.value}
              autoFocus
              size={1}
              maxLength={120}
              aria-label="Terminal name"
              onChange={(event) => tab.rename?.change(event.target.value)}
              onBlur={tab.rename.commit}
              onKeyDown={(event) => {
                if (isComposingKeyboardEvent(event.nativeEvent)) return;
                event.stopPropagation();
                if (event.key === "Enter") tab.rename?.commit();
                else if (event.key === "Escape") tab.rename?.cancel();
              }}
            />
          ) : (
            <button
              type="button"
              id={`terminal-tab-${tab.id}`}
              className={
                sharedTabs ? "ctx__terminal-select" : "terminal-tab__select"
              }
              {...(sharedTabs
                ? {
                    role: "tab" as const,
                    "aria-selected": tab.selected,
                  }
                : { "aria-pressed": tab.selected })}
              data-terminal-focus-trigger
              data-dock-tab={sharedTabs ? `terminal:${tab.id}` : undefined}
              aria-label={`${tab.label}${tab.unread ? ", new output" : ""}${tab.bell ? ", bell" : ""}`}
              aria-controls={
                sharedTabs
                  ? "context-terminal-content"
                  : tab.open
                    ? `terminal-view-${tab.id}`
                    : undefined
              }
              aria-keyshortcuts="Control+Shift+ArrowLeft Control+Shift+ArrowRight Meta+Shift+ArrowLeft Meta+Shift+ArrowRight"
              tabIndex={tab.selected ? 0 : -1}
              onClick={tab.select}
              onDoubleClick={tab.beginRename}
              onKeyDown={tab.keyDown}
              title={`${tab.label} — ${tab.title}`}
            >
              {sharedTabs ? (
                <span className="ctx__terminal-icon" aria-hidden>
                  <span
                    className={`terminal-tab__status terminal-tab__status--${tab.status}`}
                  />
                </span>
              ) : (
                <span
                  className={`terminal-tab__status terminal-tab__status--${tab.status}`}
                  aria-hidden
                />
              )}
              <span className="terminal-tab__label">{tab.label}</span>
              {tab.bell ? (
                <Bell className="terminal-tab__bell" size={10} aria-hidden />
              ) : null}
              {tab.unread ? (
                <span className="terminal-tab__unread" aria-hidden />
              ) : null}
            </button>
          )}
          <button
            type="button"
            className={sharedTabs ? "ctx__file-close" : "terminal-tab__close"}
            onClick={tab.close}
            aria-label={`Close ${tab.label}`}
            title="Close terminal"
          >
            <X size={sharedTabs ? 13 : 12} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
