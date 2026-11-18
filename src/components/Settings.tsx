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
  type InspirePreferences,
  type PiMessageDeliveryMode,
} from "../../shared/contracts";
import type { ModelSettingsDestination } from "../../shared/model-settings";
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
import { ConfirmationDialog } from "./Modal";
import { ModelsSettings } from "./ModelsSettings";
import { PresentationAdapterSettings } from "./PresentationAdapterSettings";
import { SessionActionsSettings } from "./SessionActionsSettings";
import {
  SelectField,
  SettingField,
  SettingsFeedback,
  SettingsLayout,
  SettingsPage,
  SwitchField,
} from "./SettingsControls";
import { SettingsSection as Section } from "./SettingsSection";
import { SystemVersionsCard } from "./SystemVersionsCard";

type ChoicePreference = keyof typeof preferenceChoices;

const themeIcons = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

function PreferenceChoice({
  name,
  prefs,
}: {
  name: ChoicePreference;
  prefs: InspirePreferences;
}) {
  const field = preferenceChoices[name];
  if (name === "palette")
    return (
      <SettingField label={field.label}>
        <div className="palette-picker" role="group" aria-label={field.label}>
          {preferenceChoices.palette.options.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className="palette-picker__choice"
              data-palette-choice={value}
              aria-pressed={prefs.palette === value}
              onClick={() => store.setPreference("palette", value)}
            >
              <span className="palette-picker__swatch" aria-hidden />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </SettingField>
    );
  const description = "description" in field ? field.description : undefined;
  if (
    name === "theme" ||
    name === "contentTextSize" ||
    name === "readingWidth" ||
    name === "projectDisplay" ||
    name === "desktopSendKey"
  )
    return (
      <SettingField label={field.label} description={description}>
        <div className="segmented" role="group" aria-label={field.label}>
          {preferenceChoices[name].options.map(({ value, label }) => {
            const Icon =
              name === "theme"
                ? themeIcons[value as keyof typeof themeIcons]
                : undefined;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={prefs[name] === value}
                onClick={() => store.setPreference(name, value)}
              >
                {Icon && <Icon size={13} aria-hidden />}
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </SettingField>
    );
  return (
    <SelectField
      label={field.label}
      description={description}
      value={prefs[name]}
      options={preferenceChoices[name].options}
      onChange={(value) => store.setPreference(name, value)}
    />
  );
}

const MESSAGE_DELIVERY_MODES: {
  value: PiMessageDeliveryMode;
  label: string;
}[] = [
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
  const alerts = state.taskAlerts;
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
                  className="button button--quiet"
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
                className="button button--quiet"
                onClick={() => setConfirmingReset(true)}
                title="Reset appearance and behavior preferences"
              >
                Reset preferences
              </button>
            </div>
          </footer>
        }
      >
        <SettingsPage hidden={activeCategory !== "display"}>
          <Section id="display" icon={<Palette size={14} />} title="Display">
            <PreferenceChoice name="theme" prefs={prefs} />

            <PreferenceChoice name="palette" prefs={prefs} />

            {(
              ["contentTextSize", "readingWidth", "projectDisplay"] as const
            ).map((name) => (
              <PreferenceChoice key={name} name={name} prefs={prefs} />
            ))}

            <SwitchField
              label="Titlebar needles"
              description="Animated needles in the installed app's title bar."
              checked={prefs.titlebarNeedles}
              onChange={(value) =>
                store.setPreference("titlebarNeedles", value)
              }
            />
          </Section>
        </SettingsPage>

        <SettingsPage hidden={activeCategory !== "conversation"}>
          <Section
            id="conversation"
            icon={<ScrollText size={14} />}
            title="Conversation"
          >
            {(
              [
                "thinkingVisibility",
                "toolVisibility",
                "activityFoldVisibility",
                "desktopSendKey",
              ] as const
            ).map((name) => (
              <PreferenceChoice key={name} name={name} prefs={prefs} />
            ))}
          </Section>
        </SettingsPage>

        <SettingsPage hidden={activeCategory !== "behavior"}>
          <Section id="behavior" icon={<Compass size={14} />} title="Behavior">
            <PreferenceChoice name="launch" prefs={prefs} />

            <SelectField
              label="Task alerts"
              description="This device · Notify when a background task finishes or stops with an error."
              feedback={
                alerts.mode === "desktop" ? (
                  <SettingsFeedback label="Notification status">
                    <div className="settings__field-status-block">
                      {!alerts.subscribed && alerts.permission !== "denied" && (
                        <button
                          type="button"
                          className="button button--small"
                          disabled={
                            alerts.busy || alerts.permission === "unavailable"
                          }
                          onClick={() =>
                            void store.setCompletionAttention("desktop")
                          }
                        >
                          Enable notifications
                        </button>
                      )}
                      <button
                        type="button"
                        className="button button--small"
                        disabled={
                          alerts.busy || alerts.permission !== "granted"
                        }
                        onClick={() => void store.testTaskNotification()}
                      >
                        Send test notification
                      </button>
                    </div>
                    <span role="status">
                      {notificationPermissionMessage(alerts.permission) ??
                        (alerts.subscribed
                          ? "Background notifications enabled"
                          : "While Inspire is open")}
                      {alerts.permission === "unavailable"
                        ? " On iPhone or iPad, add Inspire to the Home Screen and enable them there."
                        : null}
                    </span>
                    {alerts.testResult && (
                      <span role="status">{alerts.testResult}</span>
                    )}
                    {!alerts.subscribed && (
                      <span>
                        Background delivery uses your browser's push service. No
                        additional account is needed.
                      </span>
                    )}
                    {alerts.error && (
                      <span className="settings__error" role="alert">
                        {alerts.error}
                      </span>
                    )}
                  </SettingsFeedback>
                ) : (
                  alerts.error && (
                    <span className="settings__error" role="alert">
                      {alerts.error}
                    </span>
                  )
                )
              }
              aria-busy={alerts.busy}
              value={alerts.mode}
              options={COMPLETION_ALERTS}
              onChange={(value) => void store.setCompletionAttention(value)}
            />
            <SelectField
              label="Notification grouping"
              description="This device · One notification per session or project. Changing this clears existing task notifications."
              feedback={
                alerts.groupingError && (
                  <div className="settings__field-status-block">
                    <button
                      type="button"
                      className="button button--small"
                      disabled={alerts.groupingBusy}
                      onClick={() =>
                        void store.setTaskNotificationGrouping(alerts.grouping)
                      }
                    >
                      Retry
                    </button>
                    <span className="settings__error" role="alert">
                      {alerts.groupingError}
                    </span>
                  </div>
                )
              }
              value={alerts.grouping}
              options={[
                { value: "session", label: "Session" },
                { value: "project", label: "Project" },
              ]}
              disabled={alerts.groupingBusy}
              aria-busy={alerts.groupingBusy}
              onChange={(value) =>
                void store.setTaskNotificationGrouping(value)
              }
            />
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
                ],
                [
                  "followUpMode",
                  "Follow-up delivery",
                  "Delivery after Pi responds.",
                ],
              ] as const
            ).map(([key, label, description]) => {
              const desired = state.pendingRuntimeSettings[key];
              const value = desired ?? state.runtimeSettings?.[key];
              const pending = desired !== undefined;
              return (
                <SelectField
                  key={key}
                  label={label}
                  description={description}
                  aria-busy={pending || undefined}
                  value={value ?? ""}
                  display={value == null ? "Unavailable" : undefined}
                  options={MESSAGE_DELIVERY_MODES}
                  disabled={pending || !state.sessionId || value == null}
                  onChange={(mode) =>
                    void store.setPiRuntimeSetting({ key, value: mode })
                  }
                />
              );
            })}

            {(
              [
                [
                  "autoCompactionEnabled",
                  "Automatic context compaction",
                  "Summarize older messages when approaching the context limit.",
                ],
                [
                  "autoRetryEnabled",
                  "Automatic retry",
                  "Retry temporary provider errors.",
                ],
              ] as const
            ).map(([key, label, description]) => {
              const desired = state.pendingRuntimeSettings[key];
              const value = desired ?? state.runtimeSettings?.[key];
              const pending = desired !== undefined;
              const unavailable = !state.sessionId || value == null;
              return (
                <SwitchField
                  key={key}
                  label={label}
                  description={description}
                  status={unavailable ? "Unavailable" : undefined}
                  checked={value === true}
                  disabled={pending || unavailable}
                  onChange={(checked) =>
                    void store.setPiRuntimeSetting({ key, value: checked })
                  }
                />
              );
            })}
          </Section>
        </SettingsPage>

        <SettingsPage hidden={activeCategory !== "models"}>
          <ModelsSettings
            active={activeCategory === "models"}
            owner={modelDestination?.owner ?? workspaceOwner}
            destination={modelDestination}
          />
        </SettingsPage>

        <SettingsPage hidden={activeCategory !== "mcp"}>
          <McpSettings
            active={activeCategory === "mcp"}
            owner={workspaceOwner}
          />
        </SettingsPage>

        <SettingsPage hidden={activeCategory !== "adapters"}>
          <PresentationAdapterSettings />
        </SettingsPage>

        <SettingsPage hidden={activeCategory !== "updates"}>
          <SystemVersionsCard />

          <Section id="herdr" icon={<Server size={14} />} title="Host">
            <HerdrSettings
              onNavigateRestart={() =>
                navigate("updates", "settings-host-restart")
              }
            />
            <HostRestartSettings
              visible={activeCategory === "updates" && !suspended}
              suspended={suspended}
            />
          </Section>
        </SettingsPage>
      </SettingsLayout>
      {confirmingReset && !suspended ? (
        <ConfirmationDialog
          id="reset-preferences"
          title="Reset preferences?"
          description="Restore Display, Conversation, Behavior, and Herdr preferences to their defaults. Pi session settings, models, credentials, MCP servers, and pinned or hidden sessions stay unchanged."
          onClose={() => setConfirmingReset(false)}
          confirm={{
            label: "Reset preferences",
            run: () => {
              store.restoreDefaultSettings();
              setConfirmingReset(false);
            },
          }}
        />
      ) : null}
    </>
  );
});
