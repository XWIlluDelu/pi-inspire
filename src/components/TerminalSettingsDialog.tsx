import {
  Database,
  Minus,
  Monitor,
  MousePointer2,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalServiceSettings } from "../../shared/terminal-contracts";
import type { createApi } from "../api";
import {
  notificationPermissionMessage,
  requestBrowserNotificationPermission,
} from "../browser-notifications";
import { isMacTerminalBrowser } from "../terminal-keyboard";
import {
  DEFAULT_TERMINAL_UI_SETTINGS,
  saveTerminalUiSettings,
  type TerminalBellMode,
  type TerminalUiSettings,
} from "../terminal-settings";
import { ButtonLabel } from "./ButtonLabel";
import { DialogHeader, Modal } from "./Modal";
import {
  SegmentedField,
  SelectField,
  SettingField,
  SettingsFeedback,
  SettingsLayout,
  SwitchField,
} from "./SettingsControls";
import { SettingsCardMessage, SettingsSection } from "./SettingsSection";

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
  api: Pick<
    ReturnType<typeof createApi>,
    "terminalSettings" | "terminalOperation"
  >;
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
  const [navigation, setNavigation] = useState<{ category: CategoryId }>({
    category: "appearance",
  });

  const [serviceSettings, setServiceSettings] =
    useState<TerminalServiceSettings | null>(null);
  const [serviceError, setServiceError] = useState("");
  const [loadingService, setLoadingService] = useState(true);
  const [savingService, setSavingService] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [readRevision, setReadRevision] = useState(0);
  const [permissionFeedback, setPermissionFeedback] = useState<{
    target: "bell" | "task";
    message: string;
  } | null>(null);
  const permissionRevisions = useRef({ bell: 0, task: 0 });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

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
      if (patch.bell !== undefined) permissionRevisions.current.bell++;
      if (patch.longTaskNotifications !== undefined)
        permissionRevisions.current.task++;
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      saveTerminalUiSettings(next);
      onSettingsChange(next);
    },
    [onSettingsChange],
  );

  const updateService = useCallback(
    async (patch: Partial<TerminalServiceSettings>) => {
      setSavingService(true);
      setServiceError("");
      try {
        setServiceSettings(
          await api.terminalOperation({
            command: "updateSettings",
            params: { patch },
          }),
        );
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

  const requestDesktopPermission = useCallback(
    async (target: "bell" | "task"): Promise<boolean | null> => {
      const revision = ++permissionRevisions.current[target];
      let allowed = false;
      let message: string | null;
      try {
        const permission = await requestBrowserNotificationPermission();
        allowed = permission === "granted";
        message = notificationPermissionMessage(permission);
      } catch {
        message =
          "Could not request notification permission. Check this site's browser settings.";
      }
      if (permissionRevisions.current[target] !== revision) return null;
      setPermissionFeedback(message ? { target, message } : null);
      return allowed;
    },
    [],
  );
  const permissionStatus = (target: "bell" | "task") =>
    permissionFeedback?.target === target ? (
      <SettingsFeedback label="Notification status">
        <span role="status">{permissionFeedback.message}</span>
      </SettingsFeedback>
    ) : undefined;
  const selectBell = useCallback(
    async (bell: TerminalBellMode) => {
      setPermissionFeedback(null);
      const allowed =
        bell !== "desktop" || (await requestDesktopPermission("bell"));
      if (allowed !== null) updateUi({ bell: allowed ? bell : "visual" });
    },
    [requestDesktopPermission, updateUi],
  );
  const setLongTaskNotifications = useCallback(
    async (enabled: boolean) => {
      setPermissionFeedback(null);
      const allowed = !enabled || (await requestDesktopPermission("task"));
      if (allowed !== null)
        updateUi({ longTaskNotifications: enabled && allowed });
    },
    [requestDesktopPermission, updateUi],
  );
  const clearHistory = useCallback(async () => {
    if (!window.confirm("Delete all terminal output saved on this Host?"))
      return;
    setClearing(true);
    setServiceError("");
    try {
      await api.terminalOperation({ command: "clearHistory", params: {} });
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

  const category = CATEGORIES.find(({ id }) => id === navigation.category)!;
  const browserSettings = category.id !== "output";
  return (
    <Modal
      overlayClassName="terminal-settings-overlay"
      aria-label="Terminal settings"
      onDismiss={onClose}
    >
      <div className="dialog dialog--flush terminal-settings">
        <DialogHeader
          title="Terminal settings"
          closeLabel="Close terminal settings"
          onClose={onClose}
        />
        <SettingsLayout
          label="Terminal settings categories"
          categories={CATEGORIES}
          navigation={navigation}
          onNavigate={(category) => setNavigation({ category })}
          footer={
            <footer className="settings__footer terminal-settings__footer">
              {serviceError && serviceSettings ? (
                <span role="alert">{serviceError}</span>
              ) : null}
              <p className="terminal-settings__scope">
                {browserSettings
                  ? "Saved in this browser."
                  : "Saved on this Host."}
              </p>
              {browserSettings ? (
                <button
                  type="button"
                  className="button"
                  aria-label="Restore browser defaults"
                  onClick={() => updateUi({ ...DEFAULT_TERMINAL_UI_SETTINGS })}
                >
                  <RotateCcw size={13} aria-hidden />
                  Restore browser defaults
                </button>
              ) : null}
            </footer>
          }
        >
          <SettingsSection icon={category.icon} title={category.label}>
            {category.id === "appearance" ? (
              <>
                <SettingField label="Font size" layout="inline">
                  <div
                    className="segmented terminal-settings__stepper"
                    role="group"
                    aria-label="Terminal font size"
                  >
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Decrease terminal font size"
                      disabled={settings.fontSize <= 10}
                      onClick={() =>
                        updateUi({ fontSize: settings.fontSize - 1 })
                      }
                    >
                      <Minus size={13} aria-hidden />
                    </button>
                    <span
                      className="terminal-settings__stepper-value"
                      aria-live="polite"
                    >
                      {settings.fontSize}px
                    </span>
                    <button
                      type="button"
                      className="icon-button"
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
                <SegmentedField
                  label="Line height"
                  controlLabel="Terminal line height"
                  value={String(settings.lineHeight)}
                  options={[
                    { value: "1", label: "Compact" },
                    { value: "1.2", label: "Comfortable" },
                    { value: "1.4", label: "Spacious" },
                  ]}
                  onChange={(value) => updateUi({ lineHeight: Number(value) })}
                />
                <SegmentedField
                  label="Cursor"
                  controlLabel="Terminal cursor shape"
                  value={settings.cursorStyle}
                  options={[
                    { value: "block", label: "Block" },
                    { value: "bar", label: "Bar" },
                    { value: "underline", label: "Underline" },
                  ]}
                  onChange={(cursorStyle) => updateUi({ cursorStyle })}
                />
                <SwitchField
                  label="Blinking cursor"
                  controlLabel="Blinking terminal cursor"
                  checked={settings.cursorBlink}
                  onChange={(cursorBlink) => updateUi({ cursorBlink })}
                />
                <SelectField
                  label="Scrollback"
                  controlLabel="Terminal scrollback lines"
                  value={String(settings.scrollbackRows)}
                  options={[5000, 20000, 50000, 100000].map((rows) => ({
                    value: String(rows),
                    label: `${rows.toLocaleString("en-US")} lines`,
                  }))}
                  onChange={(value) =>
                    updateUi({ scrollbackRows: Number(value) })
                  }
                />
              </>
            ) : category.id === "interaction" ? (
              <>
                <SwitchField
                  label="Protect rich paste"
                  controlLabel="Protect terminal paste"
                  description="Confirm multiline text or control characters."
                  checked={settings.pasteProtection}
                  onChange={(pasteProtection) => updateUi({ pasteProtection })}
                />
                <SegmentedField
                  label="Shortcut priority"
                  description="Where search, copy and paste shortcuts go."
                  controlLabel="Terminal shortcut priority"
                  value={settings.shortcutMode}
                  options={[
                    { value: "workbench", label: "Workbench" },
                    { value: "shell", label: "Shell" },
                  ]}
                  onChange={(shortcutMode) => updateUi({ shortcutMode })}
                />
                {isMacTerminalBrowser() ? (
                  <SwitchField
                    label="Option as Meta"
                    controlLabel="Use Option as Meta"
                    description="Option sends shell shortcuts instead of special characters."
                    checked={settings.macOptionIsMeta}
                    onChange={(macOptionIsMeta) =>
                      updateUi({ macOptionIsMeta })
                    }
                  />
                ) : null}
                <SelectField
                  label="Bell"
                  status={permissionStatus("bell")}
                  controlLabel="Terminal bell behavior"
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
                <SwitchField
                  label="Long task notifications"
                  description="Notify when a background command finishes. Command text isn't shown."
                  status={permissionStatus("task")}
                  checked={settings.longTaskNotifications}
                  onChange={setLongTaskNotifications}
                />
                <SelectField
                  label="Long task threshold"
                  className="terminal-settings__field--subordinate"
                  controlLabel="Long task notification threshold"
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
                <SwitchField
                  label="Screen reader mode"
                  controlLabel="Terminal screen reader mode"
                  description="Make terminal output readable by screen readers. May slow rendering."
                  checked={settings.screenReaderMode}
                  onChange={(screenReaderMode) =>
                    updateUi({ screenReaderMode })
                  }
                />
              </>
            ) : serviceSettings ? (
              <>
                <SwitchField
                  label="Persist output"
                  controlLabel="Persist terminal output"
                  description="Keep output after a system restart. It may contain secrets. Turning this off deletes saved output."
                  checked={serviceSettings.persistOutput}
                  disabled={savingService}
                  onChange={(persistOutput) => {
                    if (
                      persistOutput ||
                      window.confirm(
                        "Stop saving output and delete all saved terminal output on this Host?",
                      )
                    )
                      void updateService({ persistOutput });
                  }}
                />
                <SelectField
                  label="Retention"
                  controlLabel="Terminal output retention"
                  value={String(serviceSettings.historyRetentionDays)}
                  disabled={savingService || !serviceSettings.persistOutput}
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
                <SettingField
                  label="Clear saved output"
                  description="Active terminals stay open."
                >
                  <button
                    type="button"
                    className="button button--danger-quiet"
                    disabled={clearing}
                    onClick={() => void clearHistory()}
                  >
                    <Trash2 size={13} aria-hidden />
                    <ButtonLabel reserve="Clear history">
                      {clearing ? "Clearing…" : "Clear history"}
                    </ButtonLabel>
                  </button>
                </SettingField>
              </>
            ) : (
              <SettingsCardMessage
                loading={loadingService}
                error={!loadingService}
                retry={
                  loadingService
                    ? undefined
                    : { run: () => setReadRevision((revision) => revision + 1) }
                }
              >
                {loadingService ? "Loading Host settings…" : serviceError}
              </SettingsCardMessage>
            )}
          </SettingsSection>
        </SettingsLayout>
      </div>
    </Modal>
  );
}
