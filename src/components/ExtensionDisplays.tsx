import { Package } from "lucide-react";
import { memo, useRef } from "react";
import type {
  ExtensionDisplay,
  ExtensionWidgetDisplay,
} from "../../shared/contracts";
import { stripTerminalSequences } from "../ansi";
import { CopyAction } from "./CopyAction";
import { ScrollRail } from "./ScrollRail";

type Placement = ExtensionWidgetDisplay["placement"];

function displayHeading(display: ExtensionDisplay): {
  title: string;
  detail: string | null;
} {
  const title = stripTerminalSequences(display.label).trim() || "Extension";
  const source = stripTerminalSequences(display.source).trim();
  return {
    title,
    detail: source && source !== "Pi extension" ? source : null,
  };
}

function TextWidget({ display }: { display: ExtensionWidgetDisplay }) {
  const heading = displayHeading(display);
  const text = display.lines.map(stripTerminalSequences).join("\n");
  const accessibleName = heading.detail
    ? `${heading.title} widget from ${heading.detail}`
    : `${heading.title} widget`;
  return (
    <section
      className="extension-display extension-display--widget"
      aria-label={accessibleName}
    >
      <header className="extension-display__head">
        <span className="extension-display__lead">
          <Package size={13} aria-hidden />
          <span className="extension-display__title" title={heading.title}>
            {heading.title}
          </span>
          {heading.detail ? (
            <span className="extension-display__detail" title={heading.detail}>
              {heading.detail}
            </span>
          ) : null}
        </span>
        <CopyAction
          text={text}
          label={accessibleName}
          className="extension-display__copy"
        />
      </header>
      <pre className="extension-display__text">{text}</pre>
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
