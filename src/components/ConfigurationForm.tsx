import { type ReactNode, useLayoutEffect, useRef } from "react";
import { ButtonLabel } from "./ButtonLabel";

function revealField(body: HTMLDivElement, input: Element | null) {
  if (!(input instanceof HTMLElement)) return;
  const field = input.closest<HTMLElement>("label, .models-form__field");
  if (!field) return;
  // Native autofocus scrolls the input before the editor finishes sizing.
  // Reveal its label after layout, without taking focus back from another owner.
  requestAnimationFrame(() => {
    if (!body.contains(input) || input.ownerDocument.activeElement !== input)
      return;
    const viewport = body.closest<HTMLElement>(".settings__content");
    const style = viewport && getComputedStyle(viewport);
    const available = Math.min(
      body.clientHeight,
      viewport && style
        ? viewport.clientHeight -
            (Number.parseFloat(style.scrollPaddingTop) || 0) -
            (Number.parseFloat(style.scrollPaddingBottom) || 0)
        : body.clientHeight,
    );
    // A tall textarea can exceed the viewport; retain native caret scrolling.
    if (available <= 0 || field.getBoundingClientRect().height > available)
      return;
    field.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
  });
}

export function ConfigurationForm({
  children,
  busy,
  saveDisabled,
  pendingLabel,
  onSave,
  onCancel,
}: {
  children: ReactNode;
  busy: boolean;
  saveDisabled: boolean;
  pendingLabel?: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = body.current!;
    const observer = new ResizeObserver(() =>
      revealField(element, element.ownerDocument.activeElement),
    );
    observer.observe(element);
    const viewport = element.closest(".settings__content");
    if (viewport) observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  return (
    <form
      className="models-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div
        ref={body}
        className="models-form__body"
        onFocusCapture={(event) =>
          revealField(event.currentTarget, event.target)
        }
      >
        {children}
      </div>
      <div className="models-actions models-form__actions">
        <button
          type="submit"
          className="button button--primary"
          disabled={busy || saveDisabled}
        >
          {pendingLabel ? (
            <ButtonLabel reserve={pendingLabel}>
              {busy ? pendingLabel : "Save"}
            </ButtonLabel>
          ) : (
            "Save"
          )}
        </button>
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
