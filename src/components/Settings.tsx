import {
  Compass,
  Cpu,
  Laptop,
  Monitor,
  Moon,
  Palette,
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
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  ACTIVITY_FOLD_VISIBILITIES,
  type ActivityFoldVisibilityPreference,
  type CompletionAttentionPreference,
  type ContentTextSizePreference,
  type DesktopSendKeyPreference,
  type LaunchPreference,
  PALETTE_PREFERENCES,
  type PiMessageDeliveryMode,
  type ProjectDisplayPreference,
  type ReadingWidthPreference,
  type ThemePreference,
  TOOL_VISIBILITY_PREFERENCES,
  type ToolVisibilityPreference,
  VISIBILITY_PREFERENCES,
  type VisibilityPreference,
} from "../../shared/contracts";
import type { ModelSettingsDestination } from "../../shared/model-settings";
import { notificationPermissionMessage } from "../browser-notifications";
import {
  installAvailability,
  requestInstall,
  subscribeInstallAvailability,
} from "../install-app";
import { PALETTE_LABELS, preferenceChoiceLabel } from "../preference-labels";
import { shallowEqual, store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { Dropdown } from "./Dropdown";
import { HerdrSettings } from "./HerdrSettings";
import { HostRestartSettings } from "./HostRestartSettings";
import { McpSettings } from "./McpSettings";
import { ModelsSettings } from "./ModelsSettings";
import { SessionActionsSettings } from "./SessionActionsSettings";
import {
  type SettingsChoice as Choice,
  SegmentedControl,
  SettingField,
  SettingsFeedback,
  SettingsSwitch,
} from "./SettingsControls";
import { SettingsSection as Section } from "./SettingsSection";
import { SystemVersionsCard } from "./SystemVersionsCard";

function ResetPreferencesConfirmation({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useModalFocus<HTMLDivElement>(true, "reset-preferences", onClose);
  return createPortal(
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        ref={ref}
        className="dialog host-restart-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="reset-preferences-title"
        aria-describedby="reset-preferences-description"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog__title" id="reset-preferences-title">
          Reset preferences?
        </h2>
        <p className="dialog__message" id="reset-preferences-description">
          Restore Display, Conversation, Behavior, and Herdr preferences to
          their defaults. Pi session settings, models, credentials, MCP servers,
          and pinned or hidden sessions stay unchanged.
        </p>
        <div className="host-restart__actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={onConfirm}
          >
            Reset preferences
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const THEMES: Choice<ThemePreference>[] = [
  { value: "light", label: "Light", icon: <Sun size={13} aria-hidden /> },
  { value: "dark", label: "Dark", icon: <Moon size={13} aria-hidden /> },
  { value: "system", label: "System", icon: <Monitor size={13} aria-hidden /> },
];

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

function isMessageDeliveryMode(value: string): value is PiMessageDeliveryMode {
  return value === "all" || value === "one-at-a-time";
}

const REASONING_DETAILS = VISIBILITY_PREFERENCES.map((value) => ({
  value,
  label: preferenceChoiceLabel(value),
}));

const TOOL_ACTIVITY = TOOL_VISIBILITY_PREFERENCES.map((value) => ({
  value,
  label: preferenceChoiceLabel(value),
}));

const ACTIVITY_GROUPS = ACTIVITY_FOLD_VISIBILITIES.map((value) => ({
  value,
  label: preferenceChoiceLabel(value),
  description:
    value === "dynamic"
      ? "Adjusts as live activity starts and finishes."
      : value === "expanded"
        ? "Loads and shows every activity card."
        : value === "compact"
          ? "Shows up to the latest 24 cards."
          : "Shows only the group entry until opened.",
}));

const COMPLETION_ALERTS: Array<{
  value: CompletionAttentionPreference;
  label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "title", label: "Mark tab" },
  { value: "desktop", label: "System notification" },
];

const LAUNCH_OPTIONS: Array<{ value: LaunchPreference; label: string }> = [
  { value: "welcome", label: "Show welcome page" },
  { value: "continue", label: "Continue previous session" },
];

export type SettingsCategoryId =
  | "display"
  | "conversation"
  | "behavior"
  | "models"
  | "mcp"
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
      taskAlerts: source.taskAlerts,
      version: source.version,
      sessionId: source.sessionId,
      runtimeSettings: source.runtimeSettings,
    }),
    shallowEqual,
  );
  useEffect(() => {
    void store.refreshTaskAlerts();
  }, []);
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
  const contentRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

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

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    // Wait for the selected page to be visible; scroll only this content area.
    const section = navigation.section
      ? content.querySelector<HTMLElement>(`#${navigation.section}`)
      : null;
    content.scrollTo({
      top: section
        ? content.scrollTop +
          section.getBoundingClientRect().top -
          content.getBoundingClientRect().top -
          Number.parseFloat(getComputedStyle(content).paddingTop)
        : 0,
      behavior: "instant",
    });
    const sidebar = sidebarRef.current;
    const selected = sidebar?.querySelector<HTMLElement>(
      '[aria-current="location"]',
    );
    if (!sidebar || !selected) return;
    const reveal = () =>
      selected.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "instant",
      });
    reveal();
    // A viewport change can turn this sidebar into a clipped horizontal strip.
    // Re-reveal only on size/navigation changes, not deliberate strip scrolling.
    const observer = new ResizeObserver(reveal);
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, [navigation]);

  return (
    <div className="settings__layout">
      <nav
        className="settings__sidebar"
        aria-label="Settings categories"
        ref={sidebarRef}
      >
        <div className="settings__nav-list">
          {CATEGORIES.map((category) => {
            const active = activeCategory === category.id;
            return (
              <button
                type="button"
                key={category.id}
                aria-current={active ? "location" : undefined}
                className={`settings__nav-item ${
                  active ? "settings__nav-item--active" : ""
                }`}
                onClick={() => navigate(category.id)}
              >
                <span className="settings__nav-icon">{category.icon}</span>
                <span className="settings__nav-label">{category.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div className="settings__main">
        <main className="settings__content" ref={contentRef}>
          <div
            className="settings__page"
            data-category="display"
            hidden={activeCategory !== "display"}
          >
            <Section id="display" icon={<Palette size={14} />} title="Display">
              <SettingField label="Theme">
                <SegmentedControl
                  label="Theme"
                  value={state.prefs.theme}
                  options={THEMES}
                  onChange={store.setTheme}
                />
              </SettingField>

              <SettingField label="Color palette">
                <div
                  className="palette-picker"
                  role="group"
                  aria-label="Color palette"
                >
                  {PALETTE_PREFERENCES.map((palette) => (
                    <button
                      type="button"
                      key={palette}
                      className="palette-picker__choice"
                      data-palette-choice={palette}
                      aria-pressed={state.prefs.palette === palette}
                      onClick={() => store.setPalette(palette)}
                    >
                      <span className="palette-picker__swatch" aria-hidden />
                      <span>{PALETTE_LABELS[palette]}</span>
                    </button>
                  ))}
                </div>
              </SettingField>

              <SettingField
                label="Content text size"
                description="Applies to messages, input, code and previews."
              >
                <SegmentedControl
                  label="Content text size"
                  value={state.prefs.contentTextSize}
                  options={CONTENT_TEXT_SIZES}
                  onChange={store.setContentTextSize}
                />
              </SettingField>

              <SettingField
                label="Reading width"
                description="Maximum width for messages and input."
              >
                <SegmentedControl
                  label="Reading width"
                  value={state.prefs.readingWidth}
                  options={READING_WIDTHS}
                  onChange={store.setReadingWidth}
                />
              </SettingField>

              <SettingField
                label="Project location"
                description="Project name or path in the workbench header."
              >
                <SegmentedControl
                  label="Project location"
                  value={state.prefs.projectDisplay}
                  options={PROJECT_DISPLAYS}
                  onChange={store.setProjectDisplay}
                />
              </SettingField>

              <SettingField
                label="Titlebar needles"
                description="Animated needles in the installed app's title bar."
              >
                <SettingsSwitch
                  label="Titlebar needles"
                  checked={state.prefs.titlebarNeedles}
                  onChange={store.setTitlebarNeedles}
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
              <SettingField
                label="Reasoning detail"
                description="How much model thinking to show by default."
              >
                <Dropdown
                  label="Reasoning detail"
                  className="dropdown--field"
                  value={state.prefs.thinkingVisibility}
                  options={REASONING_DETAILS}
                  onChange={(value) =>
                    store.setThinkingVisibility(value as VisibilityPreference)
                  }
                />
              </SettingField>

              <SettingField
                label="Tool activity"
                description="How much detail to show for each tool call."
              >
                <Dropdown
                  label="Tool activity"
                  className="dropdown--field"
                  value={state.prefs.toolVisibility}
                  options={TOOL_ACTIVITY}
                  onChange={(value) =>
                    store.setToolVisibility(value as ToolVisibilityPreference)
                  }
                />
              </SettingField>

              <SettingField
                label="Activity groups"
                description="Whether grouped steps start expanded or collapsed."
              >
                <Dropdown
                  label="Activity groups"
                  className="dropdown--field"
                  value={state.prefs.activityFoldVisibility}
                  options={ACTIVITY_GROUPS}
                  onChange={(value) =>
                    store.setActivityFoldVisibility(
                      value as ActivityFoldVisibilityPreference,
                    )
                  }
                />
              </SettingField>

              <SettingField
                label="Send key"
                description="Shortcut to send a message on desktop. Touch keyboards always insert a new line with Return."
              >
                <SegmentedControl
                  label="Send key"
                  value={state.prefs.desktopSendKey}
                  options={DESKTOP_SEND_KEYS}
                  onChange={store.setDesktopSendKey}
                />
              </SettingField>
            </Section>
          </div>

          <div
            className="settings__page"
            data-category="behavior"
            hidden={activeCategory !== "behavior"}
          >
            <Section
              id="behavior"
              icon={<Compass size={14} />}
              title="Behavior"
            >
              <SettingField
                label="On launch"
                description="What to open when INSΠRE starts."
              >
                <Dropdown
                  label="On launch"
                  className="dropdown--field"
                  value={state.prefs.launch}
                  options={LAUNCH_OPTIONS}
                  onChange={(value) =>
                    store.setLaunch(value as LaunchPreference)
                  }
                />
              </SettingField>

              <SettingField
                label="Task alerts"
                description="This device · Notify when a background task finishes or stops with an error."
              >
                <div className="settings__notification-control">
                  <Dropdown
                    label="Task alerts"
                    className="dropdown--field"
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
                      <SettingsFeedback
                        label="Notification status"
                        reserveLines={3}
                      >
                        <span role="status">
                          {state.taskAlerts.busy
                            ? "Updating notifications…"
                            : (notificationPermissionMessage(
                                state.taskAlerts.permission,
                              ) ??
                              (state.taskAlerts.subscribed
                                ? "Background notifications enabled"
                                : "While Inspire is open"))}
                          {!state.taskAlerts.busy &&
                          state.taskAlerts.permission === "unavailable"
                            ? " On iPhone or iPad, add Inspire to the Home Screen and enable them there."
                            : null}
                        </span>
                        {state.taskAlerts.error ? (
                          <span className="settings__error" role="alert">
                            {state.taskAlerts.error}
                          </span>
                        ) : null}
                        {state.taskAlerts.testResult ? (
                          <span role="status">
                            {state.taskAlerts.testResult}
                          </span>
                        ) : null}
                      </SettingsFeedback>
                      {!state.taskAlerts.subscribed ? (
                        <span>
                          Background delivery uses your browser's push service.
                          No additional account is needed.
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
            </Section>

            <SessionActionsSettings
              order={state.prefs.sessionActionOrder}
              onChange={store.setSessionActionOrder}
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
              <SettingField
                label="Steering delivery"
                description="How steering messages are delivered while Pi is responding."
              >
                <Dropdown
                  label="Steering delivery"
                  className="dropdown--field"
                  value={state.runtimeSettings?.steeringMode ?? ""}
                  display={
                    state.runtimeSettings?.steeringMode
                      ? undefined
                      : "Unavailable"
                  }
                  options={MESSAGE_DELIVERY_MODES}
                  disabled={
                    !state.sessionId ||
                    state.runtimeSettings?.steeringMode === null ||
                    state.runtimeSettings === null
                  }
                  onChange={(mode) => {
                    if (isMessageDeliveryMode(mode))
                      void store.setSteeringMode(mode);
                  }}
                />
              </SettingField>

              <SettingField
                label="Follow-up delivery"
                description="How queued follow-up messages are delivered after a response."
              >
                <Dropdown
                  label="Follow-up delivery"
                  className="dropdown--field"
                  value={state.runtimeSettings?.followUpMode ?? ""}
                  display={
                    state.runtimeSettings?.followUpMode
                      ? undefined
                      : "Unavailable"
                  }
                  options={MESSAGE_DELIVERY_MODES}
                  disabled={
                    !state.sessionId ||
                    state.runtimeSettings?.followUpMode === null ||
                    state.runtimeSettings === null
                  }
                  onChange={(mode) => {
                    if (isMessageDeliveryMode(mode))
                      void store.setFollowUpMode(mode);
                  }}
                />
              </SettingField>

              <SettingField
                label="Automatic context compaction"
                description="Summarize older messages when approaching the context limit."
                status={
                  !state.sessionId ||
                  state.runtimeSettings?.autoCompactionEnabled == null
                    ? "Unavailable"
                    : undefined
                }
              >
                <SettingsSwitch
                  label="Automatic context compaction"
                  checked={
                    state.runtimeSettings?.autoCompactionEnabled === true
                  }
                  disabled={
                    !state.sessionId ||
                    state.runtimeSettings?.autoCompactionEnabled == null
                  }
                  onChange={(checked) => void store.setAutoCompaction(checked)}
                />
              </SettingField>

              <SettingField
                label="Automatic retry"
                description="Retry automatically when a provider returns a temporary error."
                status={
                  !state.sessionId ||
                  state.runtimeSettings?.autoRetryEnabled == null
                    ? "Unavailable"
                    : undefined
                }
              >
                <SettingsSwitch
                  label="Automatic retry"
                  checked={state.runtimeSettings?.autoRetryEnabled === true}
                  disabled={
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
        </main>

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
      </div>
      {confirmingReset && !suspended ? (
        <ResetPreferencesConfirmation
          onClose={() => setConfirmingReset(false)}
          onConfirm={() => {
            store.restoreDefaultSettings();
            setConfirmingReset(false);
          }}
        />
      ) : null}
    </div>
  );
});
