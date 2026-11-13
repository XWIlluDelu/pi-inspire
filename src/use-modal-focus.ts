import {
  type RefObject,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { isComposingKeyboardEvent } from "./keyboard-input";

const FOCUSABLE =
  'a[href],button,input,select,textarea,summary,[contenteditable="true"],[tabindex]';
type Escape = (event: KeyboardEvent) => boolean | void;
type ModalEntry = {
  element: HTMLElement;
  owner: unknown;
  restore: HTMLElement | null;
  lastFocus?: HTMLElement | null;
  native: boolean;
  escape?: Escape;
};
const stack: ModalEntry[] = [];
const listeners = new Set<() => void>();
const top = () => stack.at(-1);
const modalDepth = () => stack.length;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const restorePoint = (node: Element | null) =>
  node instanceof HTMLElement &&
  node !== document.body &&
  node !== document.documentElement
    ? node
    : null;
function notify() {
  for (const listener of listeners) listener();
}

export function useModalDepth(): number {
  return useSyncExternalStore(subscribe, modalDepth, () => 0);
}

export function hasActiveModal(): boolean {
  return top()?.element.isConnected === true;
}

function focusable(element: HTMLElement): HTMLElement[] {
  const checked = [
    ...element.querySelectorAll<HTMLInputElement>("input[type=radio]:checked"),
  ];
  const hasLayout = element.getClientRects().length > 0;
  return [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (control) => {
      const hidden = control.closest(
        "[hidden], [inert], details:not([open]) > :not(summary)",
      );
      if (
        control.closest("dialog") !== element.closest("dialog") ||
        control.tabIndex < 0 ||
        control.matches(':disabled, [aria-hidden="true"]') ||
        (hidden && element.contains(hidden)) ||
        (hasLayout && !control.getClientRects().length)
      )
        return false;
      return !(
        control instanceof HTMLInputElement &&
        control.type === "radio" &&
        !control.checked &&
        checked.some(
          (radio) => radio.name === control.name && radio.form === control.form,
        )
      );
    },
  );
}

function focusEntry(entry: ModalEntry): void {
  const { element } = entry;
  const controls = focusable(element);
  const preferred = element.hasAttribute("data-modal-autofocus")
    ? element
    : controls.find((control) => control.hasAttribute("data-modal-autofocus"));
  (preferred ?? controls[0] ?? element).focus({ preventScroll: true });
}

/** A drawer header can remount without replacing its owner. */
export function recoverModalFocus(node: HTMLElement | null): void {
  const entry = top();
  if (
    node &&
    entry?.element.contains(node) &&
    !entry.element.contains(document.activeElement)
  )
    focusEntry(entry);
}

function containDrawerFocus(event: FocusEvent): void {
  const entry = top();
  if (entry && !entry.native && !entry.element.contains(event.target as Node))
    focusEntry(entry);
}

function modalKeys(event: KeyboardEvent): void {
  const entry = top();
  if (!entry || event.defaultPrevented || isComposingKeyboardEvent(event))
    return;
  if (event.key === "Escape") {
    if (entry.escape?.(event) === false) return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = focusable(entry.element);
  const active = document.activeElement;
  // Browsers may send Tab through chrome at a native modal's boundary.
  if (
    !controls.includes(active as HTMLElement) ||
    active === (event.shiftKey ? controls[0] : controls.at(-1))
  ) {
    event.preventDefault();
    ((event.shiftKey ? controls.at(-1) : controls[0]) ?? entry.element).focus();
  }
}

function useModalOwner<T extends HTMLElement>(
  active: boolean,
  owner: unknown,
  onEscape: Escape | undefined,
  native: boolean,
  supplied?: RefObject<T | null>,
) {
  const internal = useRef<T>(null);
  const ref = supplied ?? internal;
  const previous = useRef<ModalEntry>(null);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    if (!native || !element.parentElement?.closest("dialog:not([open])"))
      return enter();
    // Child effects run first when Settings and its confirmation resume.
    let leave: (() => void) | undefined;
    let unmounted = false;
    queueMicrotask(() => {
      if (!unmounted) leave = enter();
    });
    return () => {
      unmounted = true;
      leave?.();
    };

    function enter() {
      if (!element) return;
      const focused = document.activeElement;
      const old = previous.current;
      const current = top();
      if (current?.element.contains(focused))
        current.lastFocus = restorePoint(focused);
      const entry: ModalEntry = {
        element,
        owner,
        restore:
          old?.element === element && old.restore?.isConnected
            ? old.restore
            : !element.contains(focused)
              ? (restorePoint(focused) ?? top()?.restore ?? null)
              : null,
        native,
        escape: (event) => escape.current?.(event),
      };
      previous.current = entry;
      if (!stack.length) {
        document.addEventListener("keydown", modalKeys);
        document.addEventListener("focusin", containDrawerFocus, true);
      }
      const above = native ? -1 : stack.findIndex((entry) => entry.native);
      if (above === -1) stack.push(entry);
      else stack.splice(above, 0, entry);
      if (element instanceof HTMLDialogElement) {
        element.toggleAttribute(
          "autofocus",
          element.hasAttribute("data-modal-autofocus"),
        );
        element.showModal();
      }
      if (top() === entry && (!element.contains(focused) || native)) {
        const lastFocus = old?.owner === owner ? old?.lastFocus : null;
        if (
          lastFocus?.isConnected &&
          element.contains(lastFocus) &&
          !lastFocus.matches(":disabled")
        )
          lastFocus.focus({ preventScroll: true });
        else focusEntry(entry);
      }
      notify();

      return () => {
        const wasTop = top() === entry;
        const focused = restorePoint(document.activeElement);
        if (element.contains(focused)) entry.lastFocus = focused;
        stack.splice(stack.indexOf(entry), 1);
        if (element instanceof HTMLDialogElement) element.close();
        if (!stack.length) {
          document.removeEventListener("keydown", modalKeys);
          document.removeEventListener("focusin", containDrawerFocus, true);
        }
        for (const remaining of stack)
          if (element.contains(remaining.restore))
            remaining.restore = entry.restore;
        const remaining = top();
        if (wasTop)
          queueMicrotask(() => {
            if (top() !== remaining) return;
            const restore = entry.restore;
            if (
              restore?.isConnected &&
              (!remaining || remaining.element.contains(restore))
            )
              restore.focus({ preventScroll: true });
            else if (
              remaining &&
              !remaining.element.contains(document.activeElement)
            )
              focusEntry(remaining);
          });
        notify();
      };
    }
  }, [active, owner, native, ref]);

  useLayoutEffect(() => {
    const entry = top();
    if (
      active &&
      entry?.element === ref.current &&
      document.activeElement === entry.element &&
      !entry.element.hasAttribute("data-modal-autofocus")
    )
      focusEntry(entry);
  });

  return ref;
}

export function useDialog(
  active: boolean,
  owner: unknown,
  onEscape?: Escape,
  ref?: RefObject<HTMLDialogElement | null>,
) {
  return useModalOwner<HTMLDialogElement>(active, owner, onEscape, true, ref);
}

export function useModalFocus<T extends HTMLElement>(
  active = true,
  owner: unknown = active,
  onEscape?: Escape,
) {
  return useModalOwner<T>(active, owner, onEscape, false);
}
