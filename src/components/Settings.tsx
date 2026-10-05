import {
  Compass,
  Cpu,
  Laptop,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  ScrollText,
  Sun,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ACTIVITY_FOLD_VISIBILITIES,
  type ActivityFoldVisibilityPreference,
  type CompletionAttentionPreference,
  type ContentTextSizePreference,
  type DesktopSendKeyPreference,
  type LaunchPreference,
  type PalettePreference,
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
import {
  installAvailability,
  requestInstall,
  subscribeInstallAvailability,
} from "../install-app";
import { preferenceChoiceLabel } from "../preference-labels";
import { shallowEqual, store, useAppState } from "../store";
import { Dropdown } from "./Dropdown";
import { HerdrSettings } from "./HerdrSettings";
import { HostRestartSettings } from "./HostRestartSettings";
import { ModelsSettings } from "./ModelsSettings";
import {
  type SettingsChoice as Choice,
  SegmentedControl,
  SettingField,
  SettingsSwitch,
} from "./SettingsControls";
import { SettingsSection as Section } from "./SettingsSection";
import { SystemVersionsCard } from "./SystemVersionsCard";

const THEMES: Choice<ThemePreference>[] = [
  { value: "light", label: "Light", icon: <Sun size={13} aria-hidden /> },
  { value: "dark", label: "Dark", icon: <Moon size={13} aria-hidden /> },
  { value: "system", label: "System", icon: <Monitor size={13} aria-hidden /> },
];

const PALETTES: Choice<PalettePreference>[] = [
  { value: "amber", label: "Amber" },
  { value: "teal", label: "Jade" },
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
  { value: "mod-enter", label: "Ctrl/⌘ Enter" },
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
  { value: "desktop", label: "Desktop notification" },
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
    id: "updates",
    label: "System",
    icon: <RefreshCw size={14} aria-hidden />,
  },
];

/** Persistent workbench preferences grouped by user purpose, with secondary
 * install/about/reset utilities kept outside the settings taxonomy. */
export const SettingsContent = memo(function SettingsContent({
  initialCategory = "display",
  modelDestination,
}: {
  initialCategory?: SettingsCategoryId;
  modelDestination?: ModelSettingsDestination;
}) {
  const state = useAppState(
    (source) => ({
      prefs: source.prefs,
      version: source.version,
      sessionId: source.sessionId,
      runtimeSettings: source.runtimeSettings,
    }),
    shallowEqual,
  );
  const install = useSyncExternalStore(
    subscribeInstallAvailability,
    installAvailability,
  );
  const [activeCategory, setActiveCategory] =
    useState<CategoryId>(initialCategory);
  const contentRef = useRef<HTMLElement>(null);

  const navigate = useCallback(
    (categoryId: CategoryId, sectionId: string = categoryId) => {
      setActiveCategory(categoryId);
      const id = sectionId.startsWith("settings-")
        ? sectionId
        : `settings-section-${sectionId}`;
      document
        .getElementById(id)
        ?.scrollIntoView({ block: "start", behavior: "instant" });
    },
    [],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      navigate(
        initialCategory,
        initialCategory === "models" &&
          modelDestination?.focus === "credentials"
          ? "credentials"
          : undefined,
      ),
    );
    return () => cancelAnimationFrame(frame);
  }, [initialCategory, modelDestination?.focus, navigate]);

  const trackCategory = () => {
    const container = contentRef.current;
    if (!container) return;
    if (
      container.scrollTop + container.clientHeight >=
      container.scrollHeight - 24
    ) {
      setActiveCategory("updates");
      return;
    }
    const top = container.getBoundingClientRect().top;
    let current: CategoryId = "display";
    for (const category of CATEGORIES) {
      const section = document.getElementById(
        `settings-section-${category.id}`,
      );
      if (section && section.getBoundingClientRect().top <= top + 48)
        current = category.id;
    }
    setActiveCategory(current);
  };

  return (
    <div className="settings__layout">
      <nav className="settings__sidebar" aria-label="Settings categories">
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
        <main
          className="settings__content"
          ref={contentRef}
          onScroll={trackCategory}
        >
          <div className="settings__page" data-category="display">
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
                <SegmentedControl
                  label="Color palette"
                  value={state.prefs.palette}
                  options={PALETTES}
                  onChange={store.setPalette}
                />
              </SettingField>

              <SettingField
                label="Content text size"
                wide
                description="Applies to messages, input, code, and previews."
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
                wide
                description="Maximum width for conversation and input."
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
                wide
                description="How the project appears in the title bar."
              >
                <SegmentedControl
                  label="Project location"
                  value={state.prefs.projectDisplay}
                  options={PROJECT_DISPLAYS}
                  onChange={store.setProjectDisplay}
                />
              </SettingField>
            </Section>
          </div>

          <div className="settings__page" data-category="conversation">
            <Section
              id="conversation"
              icon={<ScrollText size={14} />}
              title="Conversation"
            >
              <SettingField
                label="Reasoning detail"
                description="How much model reasoning to show by default."
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
                description="Detail shown for individual tool calls."
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
                description="Detail shown for grouped activity."
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
                label="Assistant turn details"
                description="Show model and elapsed time between replies."
              >
                <SettingsSwitch
                  label="Assistant turn details"
                  checked={state.prefs.assistantRoundDisplay === "details"}
                  onChange={(checked) =>
                    store.setAssistantRoundDisplay(
                      checked ? "details" : "divider",
                    )
                  }
                />
              </SettingField>

              <SettingField
                label="Send key"
                wide
                description="On touch keyboards, Return adds a new line."
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

          <div className="settings__page" data-category="behavior">
            <Section
              id="behavior"
              icon={<Compass size={14} />}
              title="Behavior"
            >
              <SettingField
                label="On launch"
                description="What to show when INSΠRE opens."
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
                label="Completion alerts"
                description="Notify when work finishes in the background."
              >
                <Dropdown
                  label="Completion alerts"
                  className="dropdown--field"
                  value={state.prefs.completionAttention}
                  options={COMPLETION_ALERTS}
                  onChange={(value) =>
                    void store.setCompletionAttention(
                      value as CompletionAttentionPreference,
                    )
                  }
                />
              </SettingField>

              <SettingField
                label="Steering delivery"
                description="How Steer messages reach Pi during a task."
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
                description="How queued messages reach Pi after a task."
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
                description="Summarize older context near the model's limit."
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
                description="Retry temporary provider errors."
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

              <HerdrSettings
                onNavigateRestart={() =>
                  navigate("updates", "settings-host-restart")
                }
              />
            </Section>
          </div>

          <div className="settings__page" data-category="models">
            <ModelsSettings
              destination={
                activeCategory === "models" || initialCategory === "models"
                  ? modelDestination
                  : undefined
              }
            />
          </div>

          <div className="settings__page" data-category="updates">
            <SystemVersionsCard />

            <Section icon={<RefreshCw size={14} />} title="Restart">
              <HostRestartSettings />
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
              onClick={store.restoreDefaultSettings}
              title="Reset appearance and behavior preferences"
            >
              Reset preferences
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
});
