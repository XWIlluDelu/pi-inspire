import type { KeyboardEvent } from "react";

export function handleDockTabKey(event: KeyboardEvent<HTMLElement>) {
  const target = event.target;
  if (
    event.defaultPrevented ||
    !(target instanceof HTMLElement) ||
    target.getAttribute("role") !== "tab"
  )
    return;
  const tabs = [
    ...(target
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []),
  ].filter((tab) => !tab.closest("[hidden]"));
  const index = tabs.indexOf(target as HTMLButtonElement);
  if (index < 0) return;
  const next =
    event.key === "ArrowRight"
      ? (index + 1) % tabs.length
      : event.key === "ArrowLeft"
        ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : -1;
  if (next < 0) return;
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}
