import { AlertTriangle } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { isMacKeyboardPlatform } from "../keyboard-input";
import { store, useAppState } from "../store";
import { terminalChords } from "../terminal-keyboard";
import {
  modelCycleShortcut,
  workbenchShortcutLabel,
  workbenchShortcuts,
} from "../workbench-keyboard";
import { ContextPaneState } from "./ContextPaneState";
import { DialogHeader, Modal } from "./Modal";
import { PiLoader } from "./PiLoader";
import { ProgressiveRichText } from "./ProgressiveRichText";

type Shortcut = string | string[] | { steps: (string | string[])[] };

function ShortcutKeys({ shortcut }: { shortcut: Shortcut }) {
  const steps =
    typeof shortcut === "object" && "steps" in shortcut
      ? shortcut.steps
      : [shortcut];
  return (
    <>
      {steps.map((step, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden>·</span>}
          {(typeof step === "string" ? [step] : step).map((chord) => (
            <kbd key={chord}>{chord}</kbd>
          ))}
        </Fragment>
      ))}
    </>
  );
}

export function CommandHelp({
  mode,
  onClose,
}: {
  mode: "hotkeys" | "changelog";
  onClose: () => void;
}) {
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
  const sections: { title: string; rows: [Shortcut, string][] }[] = [
    {
      title: "Workbench",
      rows: [
        ...(["palette", "nav", "ctx"] as const).map(
          (action): [Shortcut, string] => [
            workbenchShortcutLabel(action),
            workbenchShortcuts[action].title,
          ],
        ),
        ["Esc", "Dismiss a menu or dialog; otherwise Stop active work"],
      ],
    },
    {
      title: "Composer",
      rows: [
        [
          sendKey === "mod-enter" ? "Ctrl/⌘+Enter" : "Enter",
          "Send with the selected delivery mode (desktop)",
        ],
        [
          sendKey === "mod-enter" ? ["Enter", "Shift+Enter"] : "Shift+Enter",
          "Insert a line break (Alt+Enter also works)",
        ],
        [["Alt", "↑"], "Open input history"],
        [
          {
            steps: [
              ["↑", "↓"],
              ["Enter", "Tab"],
            ],
          },
          "Choose and insert a completion",
        ],
        ["Esc", "Dismiss completion without stopping Pi"],
      ],
    },
    {
      title: "Palette and pickers",
      rows: [
        [
          { steps: [["↑", "↓"], "Enter"] },
          "Choose an action, session, or candidate",
        ],
        [["Home", "End"], "First / last model candidate in the model picker"],
        ["Esc", "Back to search, then close the palette"],
        ["Ctrl/⌘+Enter", "Run a prepared command (desktop)"],
        [["Tab", "Shift+Tab"], "Move among controls in the current dialog"],
      ],
    },
    {
      title: "Conversation",
      rows: [
        [workbenchShortcutLabel("find"), workbenchShortcuts.find.title],
        [
          ["Enter", "Shift+Enter"],
          "Next / previous match in conversation search",
        ],
        ["Esc", "Dismiss search or prompt navigation"],
      ],
    },
    {
      title: "Models",
      rows: [
        [
          [
            modelCycleShortcut("next-model"),
            modelCycleShortcut("previous-model"),
          ],
          "Next / previous common model",
        ],
        [modelCycleShortcut("thinking"), "Cycle supported thinking levels"],
      ],
    },
    {
      title: "Project terminal",
      rows: [
        ["Ctrl/⌘+F", "Find terminal output (Workbench shortcut mode)"],
        [[terminalChords.previous.hint, terminalChords.next.hint], "Previous / next terminal"],
        ["Alt+1–9", "Select a terminal tab"],
        [terminalChords.new.hint, "Create a terminal"],
        [["←", "→"], "Move focus among terminal tabs"],
        [
          ["Ctrl/⌘+Shift+←", "Ctrl/⌘+Shift+→"],
          "Reorder the focused terminal tab",
        ],
        [
          "Ctrl/⌘+K",
          "Command palette → Toggle terminal focus (Workbench mode)",
        ],
        [
          isMacKeyboardPlatform() ? ["⌘+C", "⌘+V"] : ["Ctrl+C", "Ctrl+V"],
          isMacKeyboardPlatform()
            ? "Native copy / paste; Ctrl+C always interrupts"
            : "Copy selection / paste; Ctrl+C without a selection interrupts",
        ],
        [["Enter", "Shift+Enter"], "Next / previous match in terminal search"],
      ],
    },
  ];
  return (
    <Modal
      aria-label={mode === "hotkeys" ? "Keyboard shortcuts" : "Pi changelog"}
      onDismiss={onClose}
    >
      <div className="dialog dialog--flush command-help">
        <DialogHeader
          title={
            mode === "hotkeys"
              ? "Keyboard shortcuts"
              : release
                ? `Pi ${release.version} release notes`
                : "Pi release notes"
          }
          closeLabel="Close command help"
          onClose={onClose}
        />
        <div className="command-help__body" tabIndex={0}>
          {mode === "hotkeys" ? (
            <div className="command-help__grid">
              {sections.map(({ title, rows }) => (
                <section key={title}>
                  <h3>{title}</h3>
                  {title === "Project terminal" && (
                    <p className="command-help__note">
                      With terminal focus, in Workbench shortcut mode.
                    </p>
                  )}
                  <dl>
                    {rows.map(([keys, description]) => (
                      <div key={description}>
                        <dt>
                          <ShortcutKeys shortcut={keys} />
                        </dt>
                        <dd>{description}</dd>
                      </div>
                    ))}
                  </dl>
                  {title === "Composer" && (
                    <p className="command-help__note">
                      On touch screens, Return adds a line. Tap Send. With an
                      input method, Enter confirms text while you compose.
                    </p>
                  )}
                </section>
              ))}
            </div>
          ) : error ? (
            <ContextPaneState
              icon={<AlertTriangle size={17} aria-hidden />}
              title="Release notes unavailable"
              hint={error === "Release notes unavailable" ? undefined : error}
              role="alert"
              action={{
                label: "Retry",
                run: () => setAttempt((value) => value + 1),
              }}
            />
          ) : release ? (
            <>
              <p className="palette__hint">
                Notes for your installed Pi. Links open the current docs.
              </p>
              <ProgressiveRichText
                text={release.markdown}
                variant="assistant"
              />
            </>
          ) : (
            <ContextPaneState
              icon={<PiLoader size={17} aria-hidden />}
              title="Loading installed release notes…"
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
