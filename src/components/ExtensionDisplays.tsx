import { Puzzle } from "lucide-react";
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ExtensionDisplay,
  ExtensionWidgetDisplay,
  GenericExtensionDisplay,
} from "../../shared/contracts";
import { stripTerminalSequences } from "../ansi";
import {
  controlState,
  usePresentationAdapters,
} from "../presentation-adapters";
import { shallowEqual, useAppState } from "../store";
import { AnchoredPanel } from "./ChoicePanel";
import { CodeView } from "./CodeView";
import {
  ActivityDetails,
  ActivityHeader,
  ActivityText,
} from "./transcript-activity-visibility";

type Placement = ExtensionWidgetDisplay["placement"];

function TextWidget({ display }: { display: ExtensionWidgetDisplay }) {
  const text = display.lines.map(stripTerminalSequences).join("\n");
  return (
    <div
      className="activity-surface extension-display"
      role="group"
      aria-label="Extension widget"
    >
      <ActivityHeader copy={{ text, label: "extension widget" }}>
        <CodeView className="extension-display__text" text={text} />
      </ActivityHeader>
    </div>
  );
}

const STATUS_POPOVER = {
  gap: 4,
  horizontalMargin: 8,
  verticalMargin: 8,
  maxWidth: 400,
  maxHeight: 280,
};

export const ExtensionStatus = memo(function ExtensionStatus() {
  const { statuses, sessionId } = useAppState(
    (state) => ({ statuses: state.live.statuses, sessionId: state.sessionId }),
    shallowEqual,
  );
  const { configuration } = usePresentationAdapters();
  const hidden = configuration.hiddenStatuses ?? [];
  const controls = configuration.controls ?? [];
  const visible = Object.keys(statuses)
    .sort()
    .flatMap((key) => {
      if (hidden.includes(key)) return [];
      const status = statuses[key]!;
      // A declared control's machine-readable state is consumed by that
      // control; it never needs a separate hiddenStatuses entry to stay out of
      // the header. Human-readable text under the same key remains visible.
      if (
        controls.some(
          (control) =>
            control.state.key === key && controlState(control, status) !== null,
        )
      )
        return [];
      const text = stripTerminalSequences(status);
      return text.trim() ? [text] : [];
    });
  const text = visible.join(" · ");
  const textRef = useRef<HTMLSpanElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
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

  if (!text) return null;
  return (
    <div className="topbar__extension-status">
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
          aria-controls={open ? panelId : undefined}
          title={text}
          onClick={() => setOpen((value) => !value)}
        />
      ) : null}
      <AnchoredPanel
        id={panelId}
        label="Extension status"
        open={open && truncated}
        anchorRef={toggleRef}
        onClose={() => setOpen(false)}
        constraints={STATUS_POPOVER}
        readOnly
      >
        <CodeView text={visible.join("\n\n")} />
      </AnchoredPanel>
    </div>
  );
});

/** Unknown one-way display methods stay in the Transcript. */
export function ExtensionDisplaySurface({
  displays,
}: {
  displays: GenericExtensionDisplay[];
}) {
  if (!displays.length) return null;
  return (
    <section
      className="activity-surface"
      aria-label="Extension display content"
    >
      <ActivityHeader icon={<Puzzle size={14} aria-hidden />}>
        Extension display
      </ActivityHeader>
      {displays.map(({ id, method, source, label, payload }) => (
        <ActivityDetails
          key={id}
          reader="extension-display"
          label={`${source || "Extension"} · ${label}`}
        >
          {() => (
            <ActivityText
              label="Extension display payload"
              text={`${method}\n\n${JSON.stringify(payload, null, 2) ?? ""}`}
            />
          )}
        </ActivityDetails>
      ))}
    </section>
  );
}

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
  const visible = displays.filter(
    (display): display is ExtensionWidgetDisplay =>
      display.kind === "widget" && display.placement === placement,
  );
  if (visible.length === 0) return null;
  return (
    <div
      className={`extension-dock extension-dock--${placement === "aboveEditor" ? "above" : "below"}`}
      role="region"
      tabIndex={0}
      aria-label={
        placement === "aboveEditor"
          ? "Extension content above composer"
          : "Extension content below composer"
      }
    >
      {visible.map((display) => (
        <TextWidget key={display.id} display={display} />
      ))}
    </div>
  );
});
