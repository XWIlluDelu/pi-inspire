import { type RefObject, useLayoutEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface ModalEntry {
  dialog: HTMLElement;
  restore: HTMLElement | null;
  portals: Map<HTMLElement, HTMLElement>;
  /** Return false only when a host-level recovery key must take precedence. */
  onEscape?: (event: KeyboardEvent) => boolean | void;
}

const modalStack: ModalEntry[] = [];

/** True while any modal focus owner is mounted. Global shortcuts must never
 * act through a modal, even when the focused element does not consume them. */
export function hasActiveModal(): boolean {
  return modalStack.some((entry) => entry.dialog.isConnected);
}

function containsFocus(entry: ModalEntry, node: Node | null): boolean {
  return (
    entry.dialog.contains(node) ||
    [...entry.portals.values()].some((portal) => portal.contains(node))
  );
}

function focusableElements(entry: ModalEntry): HTMLElement[] {
  const elements = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) =>
        !element.closest(
          "[hidden], [inert], details:not([open]) > :not(summary)",
        ) &&
        !element.matches(":disabled") &&
        element.getAttribute("aria-hidden") !== "true" &&
        element.tabIndex >= 0,
    );
  return elements(entry.dialog).flatMap((element) => {
    const portal = entry.portals.get(element);
    return [element, ...(portal ? elements(portal) : [])];
  });
}

function initialFocus(entry: ModalEntry): HTMLElement {
  if (entry.dialog.hasAttribute("data-modal-autofocus")) return entry.dialog;
  const elements = focusableElements(entry);
  return (
    elements.find((element) => element.hasAttribute("data-modal-autofocus")) ??
    elements[0] ??
    entry.dialog
  );
}

/** Repair focus lost when a deferred header replaces the focused control. */
export function recoverModalFocus(node: HTMLElement | null): void {
  const entry = modalStack.at(-1);
  if (
    node &&
    entry?.dialog.contains(node) &&
    !containsFocus(entry, document.activeElement)
  )
    initialFocus(entry).focus();
}

/** Keep an anchored, portaled control in its owning dialog's focus and tab order. */
export function useModalPortal(
  active: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  portalRef: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const portal = portalRef.current;
    if (!active || !anchor || !portal) return;
    const owner = [...modalStack]
      .reverse()
      .find((entry) => containsFocus(entry, anchor));
    if (!owner || owner.dialog.contains(portal)) return;
    owner.portals.set(anchor, portal);
    return () => {
      if (owner.portals.get(anchor) === portal) owner.portals.delete(anchor);
    };
  }, [active, anchorRef, portalRef]);
}

/** Own keyboard focus while an aria-modal surface is mounted, then restore
 * the element that opened it. The stack keeps a newer modal authoritative if
 * an extension request appears over another overlay. */
export function useModalFocus<T extends HTMLElement>(
  active = true,
  owner: unknown = active,
  onEscape?: (event: KeyboardEvent) => boolean | void,
): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const previousEntryRef = useRef<ModalEntry | null>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!active || !dialog) return;
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previous = previousEntryRef.current;
    const entry: ModalEntry = {
      dialog,
      // StrictMode replays layout effects after focus has entered this same
      // dialog. Preserve its outside opener, not the now-focused close button.
      restore:
        previous?.dialog === dialog && containsFocus(previous, focused)
          ? previous.restore
          : focused,
      onEscape: (event) => onEscapeRef.current?.(event),
      portals: new Map(),
    };
    previousEntryRef.current = entry;
    modalStack.push(entry);

    if (!containsFocus(entry, document.activeElement)) {
      initialFocus(entry).focus();
    }

    const containFocus = (event: FocusEvent) => {
      if (
        modalStack.at(-1) !== entry ||
        containsFocus(entry, event.target as Node)
      )
        return;
      initialFocus(entry).focus();
    };

    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        modalStack.at(-1) !== entry
      )
        return;
      // Nested controls consume Escape first. The modal then handles it before
      // window-level shell shortcuts; explicit recovery may pass through.
      if (entry.onEscape?.(event) === false) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const trapKeys = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        modalStack.at(-1) !== entry ||
        event.key !== "Tab"
      )
        return;
      const focusable = focusableElements(entry);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const focused = document.activeElement;
      const index = focusable.indexOf(focused as HTMLElement);
      if (entry.portals.size > 0 && index >= 0) {
        event.preventDefault();
        focusable[
          (index + (event.shiftKey ? -1 : 1) + focusable.length) %
            focusable.length
        ]!.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (
        event.shiftKey &&
        (focused === first || !containsFocus(entry, focused))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (focused === last || !containsFocus(entry, focused))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("focusin", containFocus, true);
    document.addEventListener("keydown", trapKeys, true);
    window.addEventListener("keydown", trapKeys, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("focusin", containFocus, true);
      document.removeEventListener("keydown", trapKeys, true);
      window.removeEventListener("keydown", trapKeys, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("keydown", escape);
      const index = modalStack.lastIndexOf(entry);
      if (index >= 0) modalStack.splice(index, 1);
      const remaining = modalStack.at(-1);
      if (remaining) {
        // If an underlying modal disappears first, preserve its opener as the
        // restoration target of the still-visible top modal.
        if (
          !remaining.restore?.isConnected ||
          containsFocus(entry, remaining.restore)
        ) {
          remaining.restore = entry.restore?.isConnected ? entry.restore : null;
        }
        const target =
          entry.restore?.isConnected && containsFocus(remaining, entry.restore)
            ? entry.restore
            : initialFocus(remaining);
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

  useLayoutEffect(() => {
    const entry = previousEntryRef.current;
    // A modal can mount while all controls are disabled, then become ready on
    // a later render. Transfer its fallback focus without taking it from a child
    // or from a newer modal, and keep the original restoration owner intact.
    if (
      active &&
      entry &&
      modalStack.at(-1) === entry &&
      document.activeElement === entry.dialog
    ) {
      initialFocus(entry).focus();
    }
  });

  return dialogRef;
}
