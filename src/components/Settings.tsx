import {
  Compass,
  Cpu,
  Laptop,
  Monitor,
  Moon,
  Palette,
  Puzzle,
  RefreshCw,
  ScrollText,
  Server,
  Sun,
  Terminal,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type CompletionAttentionPreference,
  type ContentTextSizePreference,
  type DesktopSendKeyPreference,
  type PiMessageDeliveryMode,
  type ProjectDisplayPreference,
  type ReadingWidthPreference,
} from "../../shared/contracts";
import type { ModelSettingsDestination } from "../../shared/model-settings";
import type { TaskNotificationGrouping } from "../../shared/notifications";
import { notificationPermissionMessage } from "../browser-notifications";
import {
  installAvailability,
  requestInstall,
  subscribeInstallAvailability,
} from "../install-app";
import { preferenceChoices } from "../preference-labels";
import { shallowEqual, store, useAppState } from "../store";
import { HerdrSettings } from "./HerdrSettings";
import { HostRestartSettings } from "./HostRestartSettings";
import { McpSettings } from "./McpSettings";
import { ModelsSettings } from "./ModelsSettings";
import { NativeSelect } from "./NativeSelect";
import { PresentationAdapterSettings } from "./PresentationAdapterSettings";
import { SessionActionsSettings } from "./SessionActionsSettings";
import {
  type SettingsChoice as Choice,
  SegmentedControl,
  SettingField,
  SettingsFeedback,
  SettingsLayout,
  SettingsSwitch,
} from "./SettingsControls";
import { SettingsConfirmation } from "./SettingsDialog";
import { SettingsSection as Section } from "./SettingsSection";
import { SystemVersionsCard } from "./SystemVersionsCard";

const themeIcons = { light: Sun, dark: Moon, system: Monitor };
const THEMES = preferenceChoices.theme.options.map((option) => {
  const Icon = themeIcons[option.value];
  return { ...option, icon: <Icon size={13} aria-hidden /> };
});
const CONVERSATION_CHOICES = [
  "thinkingVisibility",
  "toolVisibility",
  "activityFoldVisibility",
] as const;

const CONTENT_TEXT_SIZES: Choice<ContentTextSizePreference>[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
  { value: "large", label: "Large" },
];

const READING_WIDTHS: Choice<ReadingWidthPreference>[] = [
  { value: "narrow", label: "Narrow" },
  { value: "comfortable", label: "Comfortable" },
  { value: "wide", label: "Wide" },
];

const PROJECT_DISPLAYS: Choice<ProjectDisplayPreference>[] = [
  { value: "folder", label: "Folder name" },
  { value: "path", label: "Full path" },
];

const DESKTOP_SEND_KEYS: Choice<DesktopSendKeyPreference>[] = [
  { value: "enter", label: "Enter" },
  { value: "mod-enter", label: "Ctrl/⌘+Enter" },
];

const MESSAGE_DELIVERY_MODES: Choice<PiMessageDeliveryMode>[] = [
  { value: "one-at-a-time", label: "One at a time" },
  { value: "all", label: "All at once" },
];

const COMPLETION_ALERTS: Array<{
  value: CompletionAttentionPreference;
  label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "title", label: "Mark tab" },
  { value: "desktop", label: "System notification" },
];

export type SettingsCategoryId =
  | "display"
  | "conversation"
  | "behavior"
  | "models"
  | "mcp"
  | "adapters"
  | "updates";
type CategoryId = SettingsCategoryId;

const CATEGORIES: Array<{
  id: CategoryId;
  label: string;
  icon: ReactNode;
}> = [
  {
    id: "display",
    label: "Display",
    icon: <Palette size={14} aria-hidden />,
  },
  {
    id: "conversation",
    label: "Conversation",
    icon: <ScrollText size={14} aria-hidden />,
  },
  {
    id: "behavior",
    label: "Behavior",
    icon: <Compass size={14} aria-hidden />,
  },
  {
    id: "models",
    label: "Models",
    icon: <Cpu size={14} aria-hidden />,
  },
  {
    id: "mcp",
    label: "MCP",
    icon: <Server size={14} aria-hidden />,
  },
  { id: "adapters", label: "Adapters", icon: <Puzzle size={14} aria-hidden /> },
  {
    id: "updates",
    label: "System",
    icon: <RefreshCw size={14} aria-hidden />,
  },
];

/** Persistent workbench preferences grouped by user purpose, with secondary
 * install/about/reset utilities kept outside the settings taxonomy. */
export const SettingsContent = memo(function SettingsContent({
  suspended = false,
  initialCategory = "display",
  modelDestination,
  workspaceOwner,
}: {
  suspended?: boolean;
  initialCategory?: SettingsCategoryId;
  modelDestination?: ModelSettingsDestination;
  workspaceOwner: { sessionId?: string; cwd?: string };
}) {
  const state = useAppState(
    (source) => ({
      prefs: source.prefs,
      desiredPreferences: source.desiredPreferences,
      taskAlerts: source.taskAlerts,
      version: source.version,
      sessionId: source.sessionId,
      runtimeSettings: source.runtimeSettings,
      pendingRuntimeSettings: source.pendingRuntimeSettings,
    }),
    shallowEqual,
  );
  useEffect(() => {
    void store.refreshTaskAlerts();
  }, []);
  const prefs = { ...state.prefs, ...state.desiredPreferences };
  const install = useSyncExternalStore(
    subscribeInstallAvailability,
    installAvailability,
  );
  const [navigation, setNavigation] = useState<{
    category: CategoryId;
    section?: string;
  }>({ category: initialCategory });
  const [confirmingReset, setConfirmingReset] = useState(false);
  const activeCategory = navigation.category;

  const navigate = useCallback((category: CategoryId, section?: string) => {
    setNavigation({ category, section });
  }, []);

  useLayoutEffect(() => {
    navigate(
      initialCategory,
      initialCategory === "models" && modelDestination?.focus === "credentials"
        ? "settings-section-credentials"
        : undefined,
    );
  }, [initialCategory, modelDestination?.focus, navigate]);

  return (
    <>
      <SettingsLayout
        label="Settings categories"
        categories={CATEGORIES}
        navigation={navigation}
        onNavigate={navigate}
        busy={Object.keys(state.desiredPreferences).length > 0}
        footer={
          <footer className="settings__footer">
            <div className="settings__footer-status">
              <span className="settings__version-dot" aria-hidden />
              <span>
                INSΠRE{" "}
                {state.version ? `v${state.version}` : "version unavailable"}
              </span>
              {install === "installed" ? (
                <span className="settings__installed">App installed</span>
              ) : null}
              {install === "available" ? (
                <button
                  type="button"
                  className="settings__utility settings__install"
                  onClick={() => void requestInstall()}
                >
                  <Laptop size={13} aria-hidden />
                  Install app
                </button>
              ) : null}
            </div>
            <div className="settings__footer-actions">
              <button
                type="button"
                className="settings__utility settings__utility--reset"
                onClick={() => setConfirmingReset(true)}
                title="Reset appearance and behavior preferences"
              >
                Reset preferences
              </button>
            </div>
          </footer>
        }
      >
        <div
          className="settings__page"
          data-category="display"
          hidden={activeCategory !== "display"}
        >
          <Section id="display" icon={<Palette size={14} />} title="Display">
            <SettingField label={preferenceChoices.theme.label}>
              <SegmentedControl
                label={preferenceChoices.theme.label}
                value={prefs.theme}
                options={THEMES}
                onChange={(value) => store.setPreference("theme", value)}
              />
            </SettingField>

            <SettingField label={preferenceChoices.palette.label}>
              <div
                className="palette-picker"
                role="group"
                aria-label={preferenceChoices.palette.label}
              >
                {preferenceChoices.palette.options.map(
                  ({ value: palette, label }) => (
                    <button
                      type="button"
                      key={palette}
                      className="palette-picker__choice"
                      data-palette-choice={palette}
                      aria-pressed={prefs.palette === palette}
                      onClick={() => store.setPreference("palette", palette)}
                    >
                      <span className="palette-picker__swatch" aria-hidden />
                      <span>{label}</span>
                    </button>
                  ),
                )}
              </div>
            </SettingField>

            <SettingField
              label="Content text size"
              description="Applies to messages, input, code and previews."
            >
              <SegmentedControl
                label="Content text size"
                value={prefs.contentTextSize}
                options={CONTENT_TEXT_SIZES}
                onChange={(value) =>
                  store.setPreference("contentTextSize", value)
                }
              />
            </SettingField>

            <SettingField
              label="Reading width"
              description="Maximum width for messages and input."
            >
              <SegmentedControl
                label="Reading width"
                value={prefs.readingWidth}
                options={READING_WIDTHS}
                onChange={(value) => store.setPreference("readingWidth", value)}
              />
            </SettingField>

            <SettingField
              label="Project location"
              description="Project name or path in the workbench header."
            >
              <SegmentedControl
                label="Project location"
                value={prefs.projectDisplay}
                options={PROJECT_DISPLAYS}
                onChange={(value) =>
                  store.setPreference("projectDisplay", value)
                }
              />
            </SettingField>

            <SettingField
              label="Titlebar needles"
              layout="inline"
              description="Animated needles in the installed app's title bar."
            >
              <SettingsSwitch
                label="Titlebar needles"
                checked={prefs.titlebarNeedles}
                onChange={(value) =>
                  store.setPreference("titlebarNeedles", value)
                }
              />
            </SettingField>
          </Section>
        </div>

        <div
          className="settings__page"
          data-category="conversation"
          hidden={activeCategory !== "conversation"}
        >
          <Section
            id="conversation"
            icon={<ScrollText size={14} />}
            title="Conversation"
          >
            {CONVERSATION_CHOICES.map((key) => {
              const field = preferenceChoices[key];
              return (
                <SettingField
                  key={key}
                  label={field.label}
                  description={
                    "description" in field ? field.description : undefined
                  }
                >
                  <NativeSelect
                    label={field.label}
                    className="native-select--field"
                    value={prefs[key]}
                    options={field.options}
                    onChange={(value) => store.setPreference(key, value)}
                  />
                </SettingField>
              );
            })}

            <SettingField
              label="Send key"
              description="Desktop shortcut. Return adds a new line on touch keyboards."
            >
              <SegmentedControl
                label="Send key"
                value={prefs.desktopSendKey}
                options={DESKTOP_SEND_KEYS}
                onChange={(value) =>
                  store.setPreference("desktopSendKey", value)
                }
              />
            </SettingField>
          </Section>
        </div>

        <div
          className="settings__page"
          data-category="behavior"
          hidden={activeCategory !== "behavior"}
        >
          <Section id="behavior" icon={<Compass size={14} />} title="Behavior">
            <SettingField label={preferenceChoices.launch.label}>
              <NativeSelect
                label={preferenceChoices.launch.label}
                className="native-select--field"
                value={prefs.launch}
                options={preferenceChoices.launch.options}
                onChange={(value) => store.setPreference("launch", value)}
              />
            </SettingField>

            <SettingField
              label="Task alerts"
              description="This device · Notify when a background task finishes or stops with an error."
            >
              <div
                className="settings__notification-control"
                aria-busy={state.taskAlerts.busy}
              >
                <NativeSelect
                  label="Task alerts"
                  className="native-select--field"
                  value={state.taskAlerts.mode}
                  options={COMPLETION_ALERTS}
                  onChange={(value) =>
                    void store.setCompletionAttention(
                      value as CompletionAttentionPreference,
                    )
                  }
                />
                {state.taskAlerts.mode === "desktop" ? (
                  <div className="settings__field-status settings__notification-status">
                    <div className="settings__field-status-block">
                      {!state.taskAlerts.subscribed &&
                      state.taskAlerts.permission !== "denied" ? (
                        <button
                          type="button"
                          className="button button--small"
                          disabled={
                            state.taskAlerts.busy ||
                            state.taskAlerts.permission === "unavailable"
                          }
                          onClick={() =>
                            void store.setCompletionAttention("desktop")
                          }
                        >
                          Enable notifications
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="button button--small"
                        disabled={
                          state.taskAlerts.busy ||
                          state.taskAlerts.permission !== "granted"
                        }
                        onClick={() => void store.testTaskNotification()}
                      >
                        Send test notification
                      </button>
                    </div>
                    <SettingsFeedback label="Notification status">
                      <span role="status">
                        {notificationPermissionMessage(
                          state.taskAlerts.permission,
                        ) ??
                          (state.taskAlerts.subscribed
                            ? "Background notifications enabled"
                            : "While Inspire is open")}
                        {state.taskAlerts.permission === "unavailable"
                          ? " On iPhone or iPad, add Inspire to the Home Screen and enable them there."
                          : null}
                      </span>
                      {state.taskAlerts.error ? (
                        <span className="settings__error" role="alert">
                          {state.taskAlerts.error}
                        </span>
                      ) : null}
                      {state.taskAlerts.testResult ? (
                        <span role="status">{state.taskAlerts.testResult}</span>
                      ) : null}
                    </SettingsFeedback>
                    {!state.taskAlerts.subscribed ? (
                      <span>
                        Background delivery uses your browser's push service. No
                        additional account is needed.
                      </span>
                    ) : null}
                  </div>
                ) : state.taskAlerts.error ? (
                  <span className="settings__error">
                    {state.taskAlerts.error}
                  </span>
                ) : undefined}
              </div>
            </SettingField>
            <SettingField
              label="Notification grouping"
              description="This device · One notification per session or project. Changing this clears existing task notifications."
            >
              <div
                className="settings__notification-control"
                aria-busy={state.taskAlerts.groupingBusy}
              >
                <NativeSelect
                  label="Notification grouping"
                  className="native-select--field"
                  value={state.taskAlerts.grouping}
                  options={[
                    { value: "session", label: "Session" },
                    { value: "project", label: "Project" },
                  ]}
                  disabled={state.taskAlerts.groupingBusy}
                  onChange={(value) =>
                    void store.setTaskNotificationGrouping(
                      value as TaskNotificationGrouping,
                    )
                  }
                />
                {state.taskAlerts.groupingError ? (
                  <div className="settings__field-status settings__notification-status">
                    <span className="settings__error" role="alert">
                      {state.taskAlerts.groupingError}
                    </span>
                    <button
                      type="button"
                      className="button button--small"
                      disabled={state.taskAlerts.groupingBusy}
                      onClick={() =>
                        void store.setTaskNotificationGrouping(
                          state.taskAlerts.grouping,
                        )
                      }
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
              </div>
            </SettingField>
          </Section>

          <SessionActionsSettings
            order={prefs.sessionActionOrder}
            onChange={(value) =>
              store.setPreference("sessionActionOrder", value)
            }
          />

          <Section
            id="pi-settings"
            icon={<Terminal size={14} />}
            title={
              <>
                <span data-authored-case>Pi</span> session settings
              </>
            }
            description="Changes apply to the current session; Pi manages defaults and project overrides."
          >
            {(
              [
                [
                  "steeringMode",
                  "Steering delivery",
                  "Delivery while Pi is responding.",
                  store.setSteeringMode,
                ],
                [
                  "followUpMode",
                  "Follow-up delivery",
                  "Delivery after Pi responds.",
                  store.setFollowUpMode,
                ],
              ] as const
            ).map(([key, label, description, setMode]) => {
              const value = state.runtimeSettings?.[key];
              const pending = state.pendingRuntimeSettings[key];
              return (
                <SettingField
                  key={key}
                  label={label}
                  description={description}
                  status={pending ? "Saving…" : undefined}
                >
                  <NativeSelect
                    label={label}
                    className="native-select--field"
                    value={value ?? ""}
                    display={value == null ? "Unavailable" : undefined}
                    options={MESSAGE_DELIVERY_MODES}
                    disabled={pending || !state.sessionId || value == null}
                    onChange={(mode) => void setMode(mode)}
                  />
                </SettingField>
              );
            })}

            <SettingField
              label="Automatic context compaction"
              layout="inline"
              description="Summarize older messages when approaching the context limit."
              status={
                state.pendingRuntimeSettings.autoCompactionEnabled
                  ? "Saving…"
                  : !state.sessionId ||
                      state.runtimeSettings?.autoCompactionEnabled == null
                    ? "Unavailable"
                    : undefined
              }
            >
              <SettingsSwitch
                label="Automatic context compaction"
                checked={state.runtimeSettings?.autoCompactionEnabled === true}
                disabled={
                  state.pendingRuntimeSettings.autoCompactionEnabled === true ||
                  !state.sessionId ||
                  state.runtimeSettings?.autoCompactionEnabled == null
                }
                onChange={(checked) => void store.setAutoCompaction(checked)}
              />
            </SettingField>

            <SettingField
              label="Automatic retry"
              layout="inline"
              description="Retry temporary provider errors."
              status={
                state.pendingRuntimeSettings.autoRetryEnabled
                  ? "Saving…"
                  : !state.sessionId ||
                      state.runtimeSettings?.autoRetryEnabled == null
                    ? "Unavailable"
                    : undefined
              }
            >
              <SettingsSwitch
                label="Automatic retry"
                checked={state.runtimeSettings?.autoRetryEnabled === true}
                disabled={
                  state.pendingRuntimeSettings.autoRetryEnabled === true ||
                  !state.sessionId ||
                  state.runtimeSettings?.autoRetryEnabled == null
                }
                onChange={(checked) => void store.setAutoRetry(checked)}
              />
            </SettingField>
          </Section>
        </div>

        <div
          className="settings__page"
          data-category="models"
          hidden={activeCategory !== "models"}
        >
          <ModelsSettings
            active={activeCategory === "models"}
            destination={{
              ...modelDestination,
              owner: modelDestination?.owner ?? workspaceOwner,
            }}
          />
        </div>

        <div
          className="settings__page"
          data-category="mcp"
          hidden={activeCategory !== "mcp"}
        >
          <McpSettings
            active={activeCategory === "mcp"}
            owner={workspaceOwner}
          />
        </div>

        <div
          className="settings__page"
          data-category="adapters"
          hidden={activeCategory !== "adapters"}
        >
          <PresentationAdapterSettings />
        </div>

        <div
          className="settings__page"
          data-category="updates"
          hidden={activeCategory !== "updates"}
        >
          <SystemVersionsCard />

          <Section id="herdr" icon={<Server size={14} />} title="Host">
            <HerdrSettings
              onNavigateRestart={() =>
                navigate("updates", "settings-host-restart")
              }
            />
            <HostRestartSettings suspended={suspended} />
          </Section>
        </div>
      </SettingsLayout>
      {confirmingReset && !suspended ? (
        <SettingsConfirmation
          id="reset-preferences"
          title="Reset preferences?"
          description="Restore Display, Conversation, Behavior, and Herdr preferences to their defaults. Pi session settings, models, credentials, MCP servers, and pinned or hidden sessions stay unchanged."
          confirmLabel="Reset preferences"
          onClose={() => setConfirmingReset(false)}
          onConfirm={() => {
            store.restoreDefaultSettings();
            setConfirmingReset(false);
          }}
        />
      ) : null}
    </>
  );
});
