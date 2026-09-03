import { RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { TerminalServiceSettings } from "../../shared/terminal-contracts";
import type { createApi } from "../api";
import {
  DEFAULT_TERMINAL_UI_SETTINGS,
  saveTerminalUiSettings,
  type TerminalBellMode,
  type TerminalCursorStyle,
  type TerminalShortcutMode,
  type TerminalUiSettings,
} from "../terminal-settings";
import { useModalFocus } from "../use-modal-focus";

interface TerminalSettingsDialogProps {
  api: ReturnType<typeof createApi>;
  settings: TerminalUiSettings;
  onSettingsChange: (settings: TerminalUiSettings) => void;
  onClose: () => void;
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="terminal-settings__field">
      <div>
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <div className="terminal-settings__control">{children}</div>
    </div>
  );
}

export function TerminalSettingsDialog({
  api,
  settings,
  onSettingsChange,
  onClose,
}: TerminalSettingsDialogProps) {
  const dialogRef = useModalFocus<HTMLDivElement>(
    true,
    "terminal-settings",
    onClose,
  );
  const [serviceSettings, setServiceSettings] =
    useState<TerminalServiceSettings | null>(null);
  const [serviceError, setServiceError] = useState("");
  const [savingService, setSavingService] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .terminalSettings()
      .then((value) => {
        if (!cancelled) setServiceSettings(value);
      })
      .catch((error) => {
        if (!cancelled)
          setServiceError(
            error instanceof Error
              ? error.message
              : "Terminal settings unavailable",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const updateUi = useCallback(
    (patch: Partial<TerminalUiSettings>) => {
      const next = { ...settings, ...patch };
      saveTerminalUiSettings(next);
      onSettingsChange(next);
    },
    [onSettingsChange, settings],
  );

  const updateService = useCallback(
    async (patch: Partial<TerminalServiceSettings>) => {
      setSavingService(true);
      setServiceError("");
      try {
        setServiceSettings(await api.updateTerminalSettings(patch));
      } catch (error) {
        setServiceError(
          error instanceof Error
            ? error.message
            : "Unable to save terminal settings",
        );
      } finally {
        setSavingService(false);
      }
    },
    [api],
  );

  const requestDesktopPermission = useCallback(async (): Promise<boolean> => {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
  }, []);

  const selectBell = useCallback(
    async (bell: TerminalBellMode) => {
      if (bell === "desktop" && !(await requestDesktopPermission())) {
        updateUi({ bell: "visual" });
        return;
      }
      updateUi({ bell });
    },
    [requestDesktopPermission, updateUi],
  );

  const setLongTaskNotifications = useCallback(
    async (enabled: boolean) => {
      updateUi({
        longTaskNotifications:
          enabled && (await requestDesktopPermission()) ? true : false,
      });
    },
    [requestDesktopPermission, updateUi],
  );

  const clearHistory = useCallback(async () => {
    if (!window.confirm("Delete all terminal output saved on this Host?"))
      return;
    setClearing(true);
    setServiceError("");
    try {
      await api.clearTerminalHistory();
    } catch (error) {
      setServiceError(
        error instanceof Error
          ? error.message
          : "Unable to clear terminal history",
      );
    } finally {
      setClearing(false);
    }
  }, [api]);

  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog terminal-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-settings-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="terminal-settings__header">
          <div>
            <h2 id="terminal-settings-title">Terminal settings</h2>
            <p>
              Display choices stay on this browser. History choices apply to the
              Host.
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close terminal settings"
            title="Close"
          >
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="terminal-settings__body">
          <section aria-labelledby="terminal-appearance-title">
            <h3 id="terminal-appearance-title">Appearance</h3>
            <div className="terminal-settings__card">
              <Field
                label="Font size"
                description="Scale terminal text on this browser."
              >
                <label className="terminal-settings__range">
                  <input
                    type="range"
                    min="10"
                    max="24"
                    step="1"
                    value={settings.fontSize}
                    onChange={(event) =>
                      updateUi({ fontSize: Number(event.currentTarget.value) })
                    }
                    aria-label="Terminal font size"
                  />
                  <span>{settings.fontSize}px</span>
                </label>
              </Field>
              <Field
                label="Line height"
                description="Adjust vertical density without changing the font."
              >
                <select
                  value={settings.lineHeight}
                  onChange={(event) =>
                    updateUi({ lineHeight: Number(event.currentTarget.value) })
                  }
                  aria-label="Terminal line height"
                >
                  <option value="1">Compact</option>
                  <option value="1.2">Comfortable</option>
                  <option value="1.4">Spacious</option>
                </select>
              </Field>
              <Field
                label="Cursor"
                description="Choose the terminal cursor shape."
              >
                <select
                  value={settings.cursorStyle}
                  onChange={(event) =>
                    updateUi({
                      cursorStyle: event.currentTarget
                        .value as TerminalCursorStyle,
                    })
                  }
                  aria-label="Terminal cursor shape"
                >
                  <option value="block">Block</option>
                  <option value="bar">Bar</option>
                  <option value="underline">Underline</option>
                </select>
              </Field>
              <Field
                label="Blinking cursor"
                description="Animate the cursor while the terminal is focused."
              >
                <label className="settings-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={settings.cursorBlink}
                    onChange={(event) =>
                      updateUi({ cursorBlink: event.currentTarget.checked })
                    }
                    aria-label="Blinking terminal cursor"
                  />
                  <span className="settings-switch__track" aria-hidden>
                    <span className="settings-switch__thumb" />
                  </span>
                </label>
              </Field>
              <Field
                label="Scrollback"
                description="Lines retained by this browser while attached."
              >
                <select
                  value={settings.scrollbackRows}
                  onChange={(event) =>
                    updateUi({
                      scrollbackRows: Number(event.currentTarget.value),
                    })
                  }
                  aria-label="Terminal scrollback lines"
                >
                  <option value="5000">5,000 lines</option>
                  <option value="20000">20,000 lines</option>
                  <option value="50000">50,000 lines</option>
                  <option value="100000">100,000 lines</option>
                </select>
              </Field>
            </div>
          </section>

          <section aria-labelledby="terminal-interaction-title">
            <h3 id="terminal-interaction-title">Interaction</h3>
            <div className="terminal-settings__card">
              <Field
                label="Protect rich paste"
                description="Confirm multiline text or text containing control characters."
              >
                <label className="settings-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={settings.pasteProtection}
                    onChange={(event) =>
                      updateUi({ pasteProtection: event.currentTarget.checked })
                    }
                    aria-label="Protect terminal paste"
                  />
                  <span className="settings-switch__track" aria-hidden>
                    <span className="settings-switch__thumb" />
                  </span>
                </label>
              </Field>
              <Field
                label="Shortcut priority"
                description="Workbench keeps search, copy, and paste shortcuts; Shell sends nearly every key to the PTY."
              >
                <select
                  value={settings.shortcutMode}
                  onChange={(event) =>
                    updateUi({
                      shortcutMode: event.currentTarget
                        .value as TerminalShortcutMode,
                    })
                  }
                  aria-label="Terminal shortcut priority"
                >
                  <option value="workbench">Workbench</option>
                  <option value="shell">Shell</option>
                </select>
              </Field>
              <Field
                label="Bell"
                description="Choose how terminal bell events get your attention."
              >
                <select
                  value={settings.bell}
                  onChange={(event) =>
                    void selectBell(
                      event.currentTarget.value as TerminalBellMode,
                    )
                  }
                  aria-label="Terminal bell behavior"
                >
                  <option value="off">Off</option>
                  <option value="visual">Mark terminal tab</option>
                  <option value="desktop">Desktop notification</option>
                </select>
              </Field>
              <Field
                label="Long task notifications"
                description="Notify when a background command runs longer than the selected threshold. Command text is never shown."
              >
                <label className="settings-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={settings.longTaskNotifications}
                    onChange={(event) =>
                      void setLongTaskNotifications(event.currentTarget.checked)
                    }
                    aria-label="Long task notifications"
                  />
                  <span className="settings-switch__track" aria-hidden>
                    <span className="settings-switch__thumb" />
                  </span>
                </label>
              </Field>
              <Field
                label="Long task threshold"
                description="Short commands stay quiet."
              >
                <select
                  value={settings.longTaskThresholdSeconds}
                  disabled={!settings.longTaskNotifications}
                  onChange={(event) =>
                    updateUi({
                      longTaskThresholdSeconds: Number(
                        event.currentTarget.value,
                      ),
                    })
                  }
                  aria-label="Long task notification threshold"
                >
                  <option value={5}>5 seconds</option>
                  <option value={10}>10 seconds</option>
                  <option value={30}>30 seconds</option>
                  <option value={60}>1 minute</option>
                  <option value={300}>5 minutes</option>
                </select>
              </Field>
              <Field
                label="Screen reader mode"
                description="Expose terminal rows to assistive technology. This can reduce rendering performance."
              >
                <label className="settings-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={settings.screenReaderMode}
                    onChange={(event) =>
                      updateUi({
                        screenReaderMode: event.currentTarget.checked,
                      })
                    }
                    aria-label="Terminal screen reader mode"
                  />
                  <span className="settings-switch__track" aria-hidden>
                    <span className="settings-switch__thumb" />
                  </span>
                </label>
              </Field>
            </div>
          </section>

          <section aria-labelledby="terminal-history-title">
            <h3 id="terminal-history-title">Saved output</h3>
            <div className="terminal-settings__card">
              {serviceSettings ? (
                <>
                  <Field
                    label="Persist output"
                    description="Keep private terminal output across system restarts. Output may contain commands, tokens, and secrets. Turning this off deletes saved output."
                  >
                    <label className="settings-switch">
                      <input
                        type="checkbox"
                        role="switch"
                        checked={serviceSettings.persistOutput}
                        disabled={savingService}
                        onChange={(event) => {
                          const persistOutput = event.currentTarget.checked;
                          if (
                            !persistOutput &&
                            !window.confirm(
                              "Turn off saved output and delete all terminal history from this Host?",
                            )
                          )
                            return;
                          void updateService({ persistOutput });
                        }}
                        aria-label="Persist terminal output"
                      />
                      <span className="settings-switch__track" aria-hidden>
                        <span className="settings-switch__thumb" />
                      </span>
                    </label>
                  </Field>
                  <Field
                    label="Retention"
                    description="Delete saved output files after this many days."
                  >
                    <select
                      value={serviceSettings.historyRetentionDays}
                      disabled={savingService || !serviceSettings.persistOutput}
                      onChange={(event) =>
                        void updateService({
                          historyRetentionDays: Number(
                            event.currentTarget.value,
                          ),
                        })
                      }
                      aria-label="Terminal output retention"
                    >
                      <option value="1">1 day</option>
                      <option value="7">7 days</option>
                      <option value="30">30 days</option>
                      <option value="90">90 days</option>
                      <option value="365">1 year</option>
                    </select>
                  </Field>
                  <Field
                    label="Clear saved output"
                    description="Delete saved output without closing active terminals."
                  >
                    <button
                      type="button"
                      className="button button--danger-quiet"
                      disabled={clearing}
                      onClick={() => void clearHistory()}
                    >
                      <Trash2 size={13} aria-hidden />
                      {clearing ? "Clearing…" : "Clear history"}
                    </button>
                  </Field>
                </>
              ) : (
                <p className="terminal-settings__loading">
                  {serviceError || "Loading Host settings…"}
                </p>
              )}
            </div>
          </section>
        </div>

        <footer className="terminal-settings__footer">
          {serviceError && serviceSettings ? (
            <span role="alert">{serviceError}</span>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="button"
            onClick={() => updateUi({ ...DEFAULT_TERMINAL_UI_SETTINGS })}
          >
            <RotateCcw size={13} aria-hidden />
            Restore display defaults
          </button>
        </footer>
      </div>
    </div>
  );
}
