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
  TERMINAL_FONT_SIZE,
  type TerminalUiSettings,
} from "../terminal-settings";
import { ButtonLabel } from "./ButtonLabel";
import { DialogHeader, Modal } from "./Modal";
import {
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
  api: Pick<ReturnType<typeof createApi>, "json" | "terminalOperation">;
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
  const [serviceOperation, setServiceOperation] = useState<"saving" | "clearing" | null>(null);
  const operationInFlight = useRef(false);
  const clearing = serviceOperation === "clearing";
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
      .json("terminalSettings", {})
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

  async function changeService(patch?: Partial<TerminalServiceSettings>) {
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setServiceOperation(patch ? "saving" : "clearing");
    setServiceError("");
    try {
      if (patch)
        setServiceSettings(await api.terminalOperation({
          command: "updateSettings",
          params: { patch },
        }));
      else await api.terminalOperation({ command: "clearHistory", params: {} });
    } catch (error) {
      setServiceError(error instanceof Error ? error.message :
        patch ? "Unable to save terminal settings" : "Unable to clear terminal history");
    } finally {
      operationInFlight.current = false;
      setServiceOperation(null);
    }
  }

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
  async function updateNotification(
    choice:
      | { bell: TerminalUiSettings["bell"] }
      | { longTaskNotifications: boolean },
  ) {
    setPermissionFeedback(null);
    const target = "bell" in choice ? "bell" : "task";
    const needsPermission =
      "bell" in choice
        ? choice.bell === "desktop"
        : choice.longTaskNotifications;
    const allowed =
      !needsPermission || (await requestDesktopPermission(target));
    if (allowed === null) return;
    updateUi(
      allowed
        ? choice
        : target === "bell"
          ? { bell: "visual" }
          : { longTaskNotifications: false },
    );
  }
  const step = (Icon: typeof Minus, label: string, delta: -1 | 1) => (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      disabled={
        delta < 0
          ? settings.fontSize <= TERMINAL_FONT_SIZE.min
          : settings.fontSize >= TERMINAL_FONT_SIZE.max
      }
      onClick={() =>
        updateUi({ fontSize: settingsRef.current.fontSize + delta })
      }
    >
      <Icon size={13} aria-hidden />
    </button>
  );
  function select<Key extends keyof TerminalUiSettings>(
    key: Key,
    label: string,
    controlLabel: string,
    choices: ReadonlyArray<readonly [TerminalUiSettings[Key], string]>,
    details: { description?: string; className?: string; disabled?: boolean } = {},
  ) {
    return (
      <SelectField
        {...details}
        label={label}
        controlLabel={controlLabel}
        value={String(settings[key])}
        options={choices.map(([value, label]) => ({ value: String(value), label }))}
        onChange={(value) => {
          const choice = choices.find(([candidate]) => String(candidate) === value);
          if (choice) updateUi({ [key]: choice[0] });
        }}
      />
    );
  }
  function toggle(
    key: "cursorBlink" | "pasteProtection" | "macOptionIsMeta" | "screenReaderMode",
    label: string,
    controlLabel: string,
    description?: string,
  ) {
    return (
      <SwitchField
        label={label}
        controlLabel={controlLabel}
        description={description}
        checked={settings[key]}
        onChange={(checked) => updateUi({ [key]: checked })}
      />
    );
  }
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
                    {step(Minus, "Decrease terminal font size", -1)}
                    <span
                      className="terminal-settings__stepper-value"
                      aria-live="polite"
                    >
                      {settings.fontSize}px
                    </span>
                    {step(Plus, "Increase terminal font size", 1)}
                  </div>
                </SettingField>
                {select("lineHeight", "Line height", "Terminal line height", [
                  [1, "Compact"], [1.2, "Comfortable"], [1.4, "Spacious"],
                ])}
                {select("cursorStyle", "Cursor", "Terminal cursor shape", [
                  ["block", "Block"], ["bar", "Bar"], ["underline", "Underline"],
                ])}
                {toggle("cursorBlink", "Blinking cursor", "Blinking terminal cursor")}
                {select("scrollbackRows", "Scrollback", "Terminal scrollback lines",
                  [5000, 20000, 50000, 100000].map((rows) => [
                    rows, `${rows.toLocaleString("en-US")} lines`,
                  ] as const),
                )}
              </>
            ) : category.id === "interaction" ? (
              <>
                {toggle("pasteProtection", "Protect rich paste", "Protect terminal paste",
                  "Confirm multiline text or control characters.",
                )}
                {select("shortcutMode", "Shortcut priority", "Terminal shortcut priority", [
                  ["workbench", "Workbench"], ["shell", "Shell"],
                ], { description: "Where search, copy and paste shortcuts go." })}
                {isMacTerminalBrowser() && toggle("macOptionIsMeta", "Option as Meta", "Use Option as Meta",
                  "Option sends shell shortcuts instead of special characters.",
                )}
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
                  onChange={(bell) => void updateNotification({ bell })}
                />
                <SwitchField
                  label="Long task notifications"
                  description="Notify when a background command finishes. Command text isn't shown."
                  status={permissionStatus("task")}
                  checked={settings.longTaskNotifications}
                  onChange={(longTaskNotifications) =>
                    void updateNotification({ longTaskNotifications })
                  }
                />
                {select("longTaskThresholdSeconds", "Long task threshold", "Long task notification threshold", [
                  [5, "5 seconds"], [10, "10 seconds"], [30, "30 seconds"],
                  [60, "1 minute"], [300, "5 minutes"],
                ], {
                  disabled: !settings.longTaskNotifications,
                  className: "terminal-settings__field--subordinate",
                })}
                {toggle("screenReaderMode", "Screen reader mode", "Terminal screen reader mode",
                  "Make terminal output readable by screen readers. May slow rendering.",
                )}
              </>
            ) : serviceSettings ? (
              <>
                <SwitchField
                  label="Persist output"
                  controlLabel="Persist terminal output"
                  description="Keep output after a system restart. It may contain secrets. Turning this off deletes saved output."
                  checked={serviceSettings.persistOutput}
                  disabled={serviceOperation !== null}
                  onChange={(persistOutput) => {
                    if (
                      persistOutput ||
                      window.confirm(
                        "Stop saving output and delete all saved terminal output on this Host?",
                      )
                    )
                      void changeService({ persistOutput });
                  }}
                />
                <SelectField
                  label="Retention"
                  controlLabel="Terminal output retention"
                  value={String(serviceSettings.historyRetentionDays)}
                  disabled={serviceOperation !== null || !serviceSettings.persistOutput}
                  options={[
                    { value: "1", label: "1 day" },
                    { value: "7", label: "7 days" },
                    { value: "30", label: "30 days" },
                    { value: "90", label: "90 days" },
                    { value: "365", label: "1 year" },
                  ]}
                  onChange={(value) =>
                    void changeService({
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
                    disabled={serviceOperation !== null}
                    onClick={() => {
                      if (window.confirm("Delete all terminal output saved on this Host?"))
                        void changeService();
                    }}
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
