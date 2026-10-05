import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  ExtensionDisplay,
  ExtensionWidgetDisplay,
} from "../../shared/contracts";
import { stripTerminalSequences } from "../ansi";
import { shallowEqual, useAppState } from "../store";
import {
  type FloatingMenuConstraints,
  useFloatingMenuPlacement,
} from "../use-floating-menu";
import { CopyAction } from "./CopyAction";
import { ScrollRail } from "./ScrollRail";

type Placement = ExtensionWidgetDisplay["placement"];

function TextWidget({ display }: { display: ExtensionWidgetDisplay }) {
  const text = display.lines.map(stripTerminalSequences).join("\n");
  return (
    <div
      className="extension-display extension-display--widget"
      role="group"
      aria-label="Extension widget"
    >
      <pre className="extension-display__text">{text}</pre>
      <CopyAction
        text={text}
        label="extension widget"
        className="extension-display__copy"
      />
    </div>
  );
}

const STATUS_POPOVER: FloatingMenuConstraints = {
  gap: 4,
  horizontalMargin: 8,
  verticalMargin: 8,
  maxWidth: 400,
  maxHeight: 280,
};

export const ExtensionStatus = memo(function ExtensionStatus() {
  const { statuses, sessionId } = useAppState(
    (state) => ({ statuses: state.statuses, sessionId: state.sessionId }),
    shallowEqual,
  );
  const entries = Object.entries(statuses)
    .map(([key, text]) => [key, stripTerminalSequences(text)] as const)
    .filter(([, text]) => text.trim().length > 0)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const text = entries.map(([, value]) => value).join(" · ");
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () =>
      setTruncated(
        element.scrollWidth > element.clientWidth || text.includes("\n"),
      );
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [text]);
  useEffect(() => setOpen(false), [sessionId]);
  useLayoutEffect(() => {
    if (!truncated || !text) setOpen(false);
  }, [truncated, text]);

  const resolveTarget = useCallback(() => {
    const root = rootRef.current;
    return root
      ? { context: root, anchor: root.getBoundingClientRect(), observe: [root] }
      : null;
  }, []);
  const placement = useFloatingMenuPlacement(
    open,
    resolveTarget,
    STATUS_POPOVER,
  );
  const attachPopover = useCallback((node: HTMLDivElement | null) => {
    popoverRef.current = node;
    node?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      )
        setOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("focusin", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("focusin", dismiss);
    };
  }, [open]);

  if (!text) return null;
  return (
    <div
      ref={rootRef}
      className={`topbar__extension-status${truncated ? " topbar__extension-status--truncated" : ""}`}
    >
      <span
        ref={textRef}
        className="topbar__extension-text"
        aria-hidden={truncated || undefined}
      >
        {text}
      </span>
      {truncated ? (
        <button
          ref={toggleRef}
          type="button"
          className="topbar__extension-toggle"
          aria-label="Extension status"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={text}
          onClick={() => setOpen((value) => !value)}
        />
      ) : null}
      {open && placement
        ? createPortal(
            <div
              ref={attachPopover}
              className="extension-status-popover"
              role="dialog"
              aria-label="Extension status"
              tabIndex={0}
              style={{
                left: placement.left,
                top: placement.top,
                bottom: placement.bottom,
                width: placement.width,
                maxHeight: placement.maxHeight,
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape" || event.key === "Tab") {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                  setOpen(false);
                  toggleRef.current?.focus({ preventScroll: true });
                }
              }}
            >
              {entries.map(([key, value]) => (
                <p key={key}>{value}</p>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});

/**
 * Pi RPC text widgets stay next to the editor, preserving Pi's placement
 * semantics. Unknown one-way display methods retain the generic Transcript
 * fallback instead of being mistaken for editor widgets.
 */
export const ExtensionDisplayDock = memo(function ExtensionDisplayDock({
  displays,
  placement,
}: {
  displays: ExtensionDisplay[];
  placement: Placement;
}) {
  const dockRef = useRef<HTMLDivElement>(null);
  const visible = displays.filter(
    (display): display is ExtensionWidgetDisplay =>
      display.kind === "widget" && display.placement === placement,
  );
  if (visible.length === 0) return null;
  return (
    <div
      ref={dockRef}
      className={`extension-dock extension-dock--${placement === "aboveEditor" ? "above" : "below"}`}
      role="region"
      tabIndex={0}
      aria-label={
        placement === "aboveEditor"
          ? "Extension content above composer"
          : "Extension content below composer"
      }
    >
      <ScrollRail container={dockRef} variant="dock" />
      {visible.map((display) => (
        <TextWidget key={display.id} display={display} />
      ))}
    </div>
  );
});
