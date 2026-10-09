import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { ProgressiveRichText } from "./ProgressiveRichText";

export function CommandHelp({
  mode,
  onClose,
}: {
  mode: "hotkeys" | "changelog";
  onClose: () => void;
}) {
  const ref = useModalFocus<HTMLDivElement>(true, "command-help", onClose);
  const sendKey = useAppState((state) => state.prefs.desktopSendKey);
  const [release, setRelease] = useState<{
    version: string;
    markdown: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (mode !== "changelog") return;
    let cancelled = false;
    setError(null);
    void store.installedPiChangelog().then(
      (value) => {
        if (!cancelled) setRelease(value);
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(
            reason instanceof Error
              ? reason.message
              : "Release notes unavailable",
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mode, attempt]);
  const sections = [
    {
      title: "Workbench",
      rows: [
        ["Ctrl / ⌘ K", "Open the command palette"],
        ["Ctrl / ⌘ B", "Toggle session navigation"],
        ["Ctrl / ⌘ .", "Toggle Files / Changes / History / Terminal"],
        ["Escape", "Dismiss a menu or dialog; otherwise Stop active work"],
      ],
    },
    {
      title: "Composer",
      rows: [
        [
          sendKey === "mod-enter" ? "Ctrl / ⌘ Enter" : "Enter",
          "Send with the selected delivery mode (desktop)",
        ],
        [
          sendKey === "mod-enter" ? "Enter / Shift Enter" : "Shift Enter",
          "Insert a line break (Alt Enter also works)",
        ],
        ["↑ / ↓", "Browse prompt history at the first / last visual line"],
        ["↑ / ↓ · Enter / Tab", "Choose and insert a completion"],
        ["Escape", "Dismiss completion without stopping Pi"],
      ],
    },
    {
      title: "Palette and pickers",
      rows: [
        ["↑ / ↓ · Enter", "Choose an action, session, or candidate"],
        ["Home / End", "First / last model candidate in the model picker"],
        ["Escape", "Back to search, then close the palette"],
        ["Ctrl / ⌘ Enter", "Run a prepared command (desktop)"],
        ["Tab / Shift Tab", "Move among controls in the current dialog"],
      ],
    },
    {
      title: "Conversation",
      rows: [
        ["Ctrl / ⌘ F", "Find in the focused transcript"],
        ["Enter / Shift Enter", "Next / previous match in conversation search"],
        ["Escape", "Dismiss search or prompt navigation"],
      ],
    },
    {
      title: "Models",
      rows: [
        ["Alt Shift M / P", "Next / previous common model"],
        ["Alt Shift R", "Cycle supported thinking levels"],
      ],
    },
    {
      title: "Project terminal",
      rows: [
        ["Ctrl / ⌘ F", "Find terminal output (Workbench shortcut mode)"],
        ["Ctrl / ⌘ PageUp / PageDown", "Previous / next terminal"],
        ["Alt 1–9", "Select a terminal tab"],
        ["Ctrl / ⌘ Shift `", "Create a terminal"],
        ["← / →", "Move focus among terminal tabs"],
        ["Ctrl / ⌘ Shift ← / →", "Reorder the focused terminal tab"],
        ["Ctrl Shift Escape", "Release terminal keyboard focus"],
        [
          "Ctrl / ⌘ C / V",
          "Copy selection / paste; Ctrl C without a selection interrupts",
        ],
        ["Enter / Shift Enter", "Next / previous match in terminal search"],
      ],
    },
  ];
  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        ref={ref}
        className="dialog dialog--wide command-help"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "hotkeys" ? "Keyboard shortcuts" : "Pi changelog"}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="command-help__header">
          <h2>
            {mode === "hotkeys"
              ? "Keyboard shortcuts"
              : release
                ? `Pi ${release.version} release notes`
                : "Pi release notes"}
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close command help"
            onClick={onClose}
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="command-help__body" tabIndex={0}>
          {mode === "hotkeys" ? (
            <div className="command-help__grid">
              {[0, 1].map((column) => (
                <div className="command-help__column" key={column}>
                  {sections
                    .filter((_, index) => index % 2 === column)
                    .map((section) => (
                      <section key={section.title}>
                        <h3>{section.title}</h3>
                        {section.title === "Project terminal" ? (
                          <p className="command-help__note">
                            With terminal focus, in Workbench shortcut mode.
                          </p>
                        ) : null}
                        <dl>
                          {section.rows.map(([key, value]) => (
                            <div key={key}>
                              <dt>
                                <kbd>{key}</kbd>
                              </dt>
                              <dd>{value}</dd>
                            </div>
                          ))}
                        </dl>
                        {section.title === "Composer" ? (
                          <p className="command-help__note">
                            Touch-first input: Return inserts a line break; use
                            Send. IME composition: Enter confirms, never
                            submits.
                          </p>
                        ) : null}
                      </section>
                    ))}
                </div>
              ))}
            </div>
          ) : error ? (
            <div role="alert">
              <p>{error}</p>
              <button
                type="button"
                className="button button--quiet"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </button>
            </div>
          ) : release ? (
            <>
              <p className="palette__hint">
                From the installed Pi package. Documentation links open current
                upstream documentation.
              </p>
              <ProgressiveRichText
                text={release.markdown}
                variant="assistant"
              />
            </>
          ) : (
            <p role="status">Loading installed release notes…</p>
          )}
        </div>
      </div>
    </div>
  );
}
