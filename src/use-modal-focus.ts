import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface ModalEntry {
  dialog: HTMLElement;
  restore: HTMLElement | null;
}

const modalStack: ModalEntry[] = [];

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.tabIndex >= 0,
  );
}

/** Own keyboard focus while an aria-modal surface is mounted, then restore
 * the element that opened it. The stack keeps a newer modal authoritative if
 * an extension request appears over another overlay. */
export function useModalFocus<T extends HTMLElement>(
  active = true,
  owner: unknown = active,
): RefObject<T | null> {
  const dialogRef = useRef<T>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!active || !dialog) return;
    const entry: ModalEntry = {
      dialog,
      restore:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    };
    modalStack.push(entry);

    if (!dialog.contains(document.activeElement)) {
      (focusableElements(dialog)[0] ?? dialog).focus();
    }

    const containFocus = (event: FocusEvent) => {
      if (modalStack.at(-1) !== entry || dialog.contains(event.target as Node))
        return;
      (focusableElements(dialog)[0] ?? dialog).focus();
    };

    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || modalStack.at(-1) !== entry) return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const focused = document.activeElement;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (focused === first || !dialog.contains(focused))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (focused === last || !dialog.contains(focused))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("focusin", containFocus, true);
    document.addEventListener("keydown", trapTab, true);
    return () => {
      document.removeEventListener("focusin", containFocus, true);
      document.removeEventListener("keydown", trapTab, true);
      const index = modalStack.lastIndexOf(entry);
      if (index >= 0) modalStack.splice(index, 1);
      const remaining = modalStack.at(-1);
      if (remaining) {
        // If an underlying modal disappears first, preserve its opener as the
        // restoration target of the still-visible top modal.
        if (
          !remaining.restore?.isConnected ||
          dialog.contains(remaining.restore)
        ) {
          remaining.restore = entry.restore?.isConnected ? entry.restore : null;
        }
        const target =
          entry.restore?.isConnected && remaining.dialog.contains(entry.restore)
            ? entry.restore
            : (focusableElements(remaining.dialog)[0] ?? remaining.dialog);
        queueMicrotask(() => {
          if (modalStack.at(-1) === remaining && target.isConnected)
            target.focus();
        });
      } else {
        const restore = entry.restore;
        queueMicrotask(() => {
          if (modalStack.length === 0 && restore?.isConnected) restore.focus();
        });
      }
    };
  }, [active, owner]);

  return dialogRef;
}
