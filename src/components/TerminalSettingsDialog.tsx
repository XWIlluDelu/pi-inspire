import {
  Database,
  Minus,
  Monitor,
  MousePointer2,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TerminalServiceSettings } from "../../shared/terminal-contracts";
import type { createApi } from "../api";
import {
  DEFAULT_TERMINAL_UI_SETTINGS,
  saveTerminalUiSettings,
  type TerminalBellMode,
  type TerminalUiSettings,
} from "../terminal-settings";
import { useModalFocus } from "../use-modal-focus";
import { Dropdown } from "./Dropdown";
import {
  SegmentedControl,
  SettingField,
  SettingsSwitch,
} from "./SettingsControls";
import { SettingsSection } from "./SettingsSection";

const CATEGORIES = [
  { id: "appearance", label: "Appearance", icon: <Monitor size={14} /> },
  {
    id: "interaction",
    label: "Interaction",
    icon: <MousePointer2 size={14} />,
  },
  { id: "output", label: "Saved output", icon: <Database size={14} /> },
] as const;
type CategoryId = (typeof CATEGORIES)[number]["id"];

interface TerminalSettingsDialogProps {
  api: ReturnType<typeof createApi>;
  settings: TerminalUiSettings;
  onSettingsChange: (settings: TerminalUiSettings) => void;
  onClose: () => void;
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
  const [navigation, setNavigation] = useState<{ category: CategoryId }>({
    category: "appearance",
  });
  const contentRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: "instant" });
    sidebarRef.current
      ?.querySelector<HTMLElement>('[aria-current="location"]')
      ?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "instant",
      });
  }, [navigation]);

  const [serviceSettings, setServiceSettings] =
    useState<TerminalServiceSettings | null>(null);
  const [serviceError, setServiceError] = useState("");
  const [loadingService, setLoadingService] = useState(true);
  const [savingService, setSavingService] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [readRevision, setReadRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadingService(true);
    setServiceError("");
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
      })
      .finally(() => {
        if (!cancelled) setLoadingService(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, readRevision]);

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
      updateUi({
        bell:
          bell === "desktop" && !(await requestDesktopPermission())
            ? "visual"
            : bell,
      });
    },
    [requestDesktopPermission, updateUi],
  );
  const setLongTaskNotifications = useCallback(
    async (enabled: boolean) => {
      updateUi({
        longTaskNotifications: enabled && (await requestDesktopPermission()),
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
    <div
      className="overlay terminal-settings-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="dialog terminal-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-settings-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings__header terminal-settings__header">
          <h2 id="terminal-settings-title" className="settings__title">
            Terminal settings
          </h2>
          <button
            type="button"
            className="icon-button settings__close-btn"
            onClick={onClose}
            aria-label="Close terminal settings"
            title="Close"
          >
            <X size={15} aria-hidden />
          </button>
        </header>
        <div className="settings__layout">
          <nav
            className="settings__sidebar"
            aria-label="Terminal settings categories"
            ref={sidebarRef}
          >
            <div className="settings__nav-list">
              {CATEGORIES.map((category) => {
                const active = navigation.category === category.id;
                return (
                  <button
                    type="button"
                    key={category.id}
                    aria-current={active ? "location" : undefined}
                    className={`settings__nav-item ${active ? "settings__nav-item--active" : ""}`}
                    onClick={() => setNavigation({ category: category.id })}
                  >
                    <span className="settings__nav-icon">{category.icon}</span>
                    <span className="settings__nav-label">
                      {category.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>
          <div className="settings__main">
            <main className="terminal-settings__body" ref={contentRef}>
              {navigation.category === "appearance" ? (
                <SettingsSection
                  icon={<Monitor size={14} />}
                  title="Appearance"
                >
                  <SettingField
                    label="Font size"
                    className="terminal-settings__font"
                  >
                    <div
                      className="terminal-settings__stepper"
                      role="group"
                      aria-label="Terminal font size"
                    >
                      <button
                        type="button"
                        className="terminal-settings__stepper-btn"
                        aria-label="Decrease terminal font size"
                        disabled={settings.fontSize <= 10}
                        onClick={() =>
                          updateUi({ fontSize: settings.fontSize - 1 })
                        }
                      >
                        <Minus size={13} aria-hidden />
                      </button>
                      <span
                        className="terminal-settings__stepper-val terminal-settings__stepper-value"
                        aria-live="polite"
                      >
                        {settings.fontSize}px
                      </span>
                      <button
                        type="button"
                        className="terminal-settings__stepper-btn"
                        aria-label="Increase terminal font size"
                        disabled={settings.fontSize >= 24}
                        onClick={() =>
                          updateUi({ fontSize: settings.fontSize + 1 })
                        }
                      >
                        <Plus size={13} aria-hidden />
                      </button>
                    </div>
                  </SettingField>
                  <SettingField label="Line height" wide>
                    <SegmentedControl
                      label="Terminal line height"
                      value={String(settings.lineHeight)}
                      options={[
                        { value: "1", label: "Compact" },
                        { value: "1.2", label: "Comfortable" },
                        { value: "1.4", label: "Spacious" },
                      ]}
                      onChange={(value) =>
                        updateUi({ lineHeight: Number(value) })
                      }
                    />
                  </SettingField>
                  <SettingField label="Cursor" wide>
                    <SegmentedControl
                      label="Terminal cursor shape"
                      value={settings.cursorStyle}
                      options={[
                        { value: "block", label: "Block" },
                        { value: "bar", label: "Bar" },
                        { value: "underline", label: "Underline" },
                      ]}
                      onChange={(cursorStyle) => updateUi({ cursorStyle })}
                    />
                  </SettingField>
                  <SettingField label="Blinking cursor">
                    <SettingsSwitch
                      label="Blinking terminal cursor"
                      checked={settings.cursorBlink}
                      onChange={(cursorBlink) => updateUi({ cursorBlink })}
                    />
                  </SettingField>
                  <SettingField label="Scrollback">
                    <Dropdown
                      label="Terminal scrollback lines"
                      className="dropdown--field"
                      value={String(settings.scrollbackRows)}
                      options={[5000, 20000, 50000, 100000].map((rows) => ({
                        value: String(rows),
                        label: `${rows.toLocaleString("en-US")} lines`,
                      }))}
                      onChange={(value) =>
                        updateUi({ scrollbackRows: Number(value) })
                      }
                    />
                  </SettingField>
                </SettingsSection>
              ) : null}
              {navigation.category === "interaction" ? (
                <SettingsSection
                  icon={<MousePointer2 size={14} />}
                  title="Interaction"
                >
                  <SettingField
                    label="Protect rich paste"
                    description="Confirm multiline text or control characters."
                  >
                    <SettingsSwitch
                      label="Protect terminal paste"
                      checked={settings.pasteProtection}
                      onChange={(pasteProtection) =>
                        updateUi({ pasteProtection })
                      }
                    />
                  </SettingField>
                  <SettingField
                    label="Shortcut priority"
                    wide
                    description="Which side receives search, copy and paste shortcuts."
                  >
                    <SegmentedControl
                      label="Terminal shortcut priority"
                      value={settings.shortcutMode}
                      options={[
                        { value: "workbench", label: "Workbench" },
                        { value: "shell", label: "Shell" },
                      ]}
                      onChange={(shortcutMode) => updateUi({ shortcutMode })}
                    />
                  </SettingField>
                  <SettingField label="Bell">
                    <Dropdown
                      label="Terminal bell behavior"
                      className="dropdown--field"
                      value={settings.bell}
                      options={[
                        { value: "off", label: "Off" },
                        { value: "visual", label: "Mark terminal tab" },
                        { value: "desktop", label: "Desktop notification" },
                      ]}
                      onChange={(value) =>
                        void selectBell(value as TerminalBellMode)
                      }
                    />
                  </SettingField>
                  <SettingField
                    label="Long task notifications"
                    description="Notify when a background command finishes. Command text isn't shown."
                  >
                    <SettingsSwitch
                      label="Long task notifications"
                      checked={settings.longTaskNotifications}
                      onChange={(enabled) =>
                        void setLongTaskNotifications(enabled)
                      }
                    />
                  </SettingField>
                  <SettingField
                    label="Long task threshold"
                    className={`terminal-settings__field--subordinate${
                      !settings.longTaskNotifications
                        ? " terminal-settings__field--disabled"
                        : ""
                    }`}
                  >
                    <Dropdown
                      label="Long task notification threshold"
                      className="dropdown--field"
                      value={String(settings.longTaskThresholdSeconds)}
                      disabled={!settings.longTaskNotifications}
                      options={[
                        { value: "5", label: "5 seconds" },
                        { value: "10", label: "10 seconds" },
                        { value: "30", label: "30 seconds" },
                        { value: "60", label: "1 minute" },
                        { value: "300", label: "5 minutes" },
                      ]}
                      onChange={(value) =>
                        updateUi({ longTaskThresholdSeconds: Number(value) })
                      }
                    />
                  </SettingField>
                  <SettingField
                    label="Screen reader mode"
                    description="Expose terminal rows to assistive technology. May slow rendering."
                  >
                    <SettingsSwitch
                      label="Terminal screen reader mode"
                      checked={settings.screenReaderMode}
                      onChange={(screenReaderMode) =>
                        updateUi({ screenReaderMode })
                      }
                    />
                  </SettingField>
                </SettingsSection>
              ) : null}
              {navigation.category === "output" ? (
                <SettingsSection
                  icon={<Database size={14} />}
                  title="Saved output"
                  description="Stored on the connected Host."
                >
                  {serviceSettings ? (
                    <>
                      <SettingField
                        label="Persist output"
                        description="Keep output across system restarts. It may contain secrets. Turning this off deletes saved output."
                      >
                        <SettingsSwitch
                          label="Persist terminal output"
                          checked={serviceSettings.persistOutput}
                          disabled={savingService}
                          onChange={(persistOutput) => {
                            if (
                              !persistOutput &&
                              !window.confirm(
                                "Turn off saved output and delete all terminal history from this Host?",
                              )
                            )
                              return;
                            void updateService({ persistOutput });
                          }}
                        />
                      </SettingField>
                      <SettingField label="Retention">
                        <Dropdown
                          label="Terminal output retention"
                          className="dropdown--field"
                          value={String(serviceSettings.historyRetentionDays)}
                          disabled={
                            savingService || !serviceSettings.persistOutput
                          }
                          options={[
                            { value: "1", label: "1 day" },
                            { value: "7", label: "7 days" },
                            { value: "30", label: "30 days" },
                            { value: "90", label: "90 days" },
                            { value: "365", label: "1 year" },
                          ]}
                          onChange={(value) =>
                            void updateService({
                              historyRetentionDays: Number(value),
                            })
                          }
                        />
                      </SettingField>
                      <SettingField
                        label="Clear saved output"
                        description="Active terminals stay open."
                        wide
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
                      </SettingField>
                    </>
                  ) : (
                    <div className="terminal-settings__loading">
                      {loadingService ? (
                        <p role="status">Loading Host settings…</p>
                      ) : (
                        <>
                          <p role="alert">{serviceError}</p>
                          <button
                            type="button"
                            className="button"
                            onClick={() =>
                              setReadRevision((revision) => revision + 1)
                            }
                          >
                            Retry
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </SettingsSection>
              ) : null}
            </main>
            <footer className="terminal-settings__footer">
              {serviceError && serviceSettings ? (
                <span role="alert">{serviceError}</span>
              ) : null}
              <p className="terminal-settings__scope">Saved in this browser.</p>
              <button
                type="button"
                className="button"
                aria-label="Restore browser defaults"
                onClick={() => updateUi({ ...DEFAULT_TERMINAL_UI_SETTINGS })}
              >
                <RotateCcw size={13} aria-hidden />
                Restore defaults
              </button>
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}
