import {
  Compass,
  Laptop,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  ScrollText,
  Sun,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ACTIVITY_FOLD_VISIBILITIES,
  TOOL_VISIBILITY_PREFERENCES,
  VISIBILITY_PREFERENCES,
  type ActivityFoldVisibilityPreference,
  type CompletionAttentionPreference,
  type ContentTextSizePreference,
  type DesktopSendKeyPreference,
  type LaunchPreference,
  type PalettePreference,
  type PiUpdateCheckResponse,
  type ProjectDisplayPreference,
  type ReadingWidthPreference,
  type ThemePreference,
  type ToolVisibilityPreference,
  type UpdateCheckResponse,
  type VisibilityPreference,
} from "../../shared/contracts";
import {
  installAvailability,
  requestInstall,
  subscribeInstallAvailability,
} from "../install-app";
import { preferenceChoiceLabel } from "../preference-labels";
import { shallowEqual, store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { Dropdown } from "./Dropdown";

interface Choice<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

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
    id: "updates",
    label: "Updates",
    icon: <RefreshCw size={14} aria-hidden />,
  },
];

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Choice<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={`segmented__item ${
            value === option.value ? "segmented__item--active" : ""
          }`}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          title={option.label}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function SettingField({
  label,
  description,
  children,
  stacked = false,
}: {
  label: string;
  description: string;
  children: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div
      className={`settings__field ${stacked ? "settings__field--stacked" : ""}`}
    >
      <div className="settings__field-info">
        <span className="settings__field-label">{label}</span>
        <p className="settings__field-help">{description}</p>
      </div>
      <div className="settings__field-control">{children}</div>
    </div>
  );
}

function Section({
  id,
  icon,
  title,
  description,
  children,
}: {
  id: CategoryId;
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={`settings-section-${id}`}
      className="settings__section"
      aria-label={title}
    >
      <div className="settings__section-header">
        <div className="settings__section-title-wrap">
          <span className="settings__section-icon" aria-hidden>
            {icon}
          </span>
          <h3 className="settings__section-title">{title}</h3>
        </div>
        {description ? (
          <p className="settings__section-desc">{description}</p>
        ) : null}
      </div>
      <div className="settings__card">{children}</div>
    </section>
  );
}

function UpdateCheckButton({
  label,
  checked,
  checking,
  onClick,
}: {
  label: string;
  checked: boolean;
  checking: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="settings__update-check"
      aria-label={label}
      disabled={checking}
      onClick={onClick}
    >
      <RefreshCw
        size={13}
        className={checking ? "spin" : undefined}
        aria-hidden
      />
      {checking ? "Checking" : checked ? "Check again" : "Check now"}
    </button>
  );
}

function UpdateStatusRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="settings__update-status-row">
      <span className="settings__update-status-label">{label}</span>
      <div className="settings__update-status-value">{children}</div>
    </div>
  );
}

function PiUpdateStatus({
  currentVersion,
  check,
  checking,
}: {
  currentVersion: string;
  check: PiUpdateCheckResponse | null;
  checking: boolean;
}) {
  const version = check?.currentVersion || currentVersion;
  const pending = checking && !check;
  return (
    <div
      className="settings__update-status"
      aria-live="polite"
      aria-busy={checking}
    >
      <UpdateStatusRow label="Pi">
        <span>{version ? `v${version}` : "Version unavailable"}</span>
        {pending ? (
          <span className="settings__update-state">Checking…</span>
        ) : check?.pi.kind === "available" ? (
          <>
            <a
              className="settings__update-link"
              href={check.pi.releaseUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              v{check.pi.latestVersion} available
            </a>
            <code className="settings__update-command">pi update</code>
          </>
        ) : check?.pi.kind === "current" ? (
          <span className="settings__update-state">Up to date</span>
        ) : check?.pi.kind === "unavailable" ? (
          <span className="settings__update-state">Check unavailable</span>
        ) : (
          <span className="settings__update-state">Not checked</span>
        )}
      </UpdateStatusRow>

      <UpdateStatusRow label="Extensions">
        {pending ? (
          <span className="settings__update-state">Checking…</span>
        ) : check?.extensions.kind === "available" ? (
          <div className="settings__update-packages">
            <span className="settings__update-link">
              {check.extensions.updates.length}{" "}
              {check.extensions.updates.length === 1 ? "update" : "updates"}
            </span>
            <ul>
              {check.extensions.updates.map((update, index) => (
                <li key={`${update.type}:${update.displayName}:${index}`}>
                  {update.displayName}
                </li>
              ))}
            </ul>
            <code className="settings__update-command">
              pi update --extensions
            </code>
          </div>
        ) : check?.extensions.kind === "none" ? (
          <span className="settings__update-state">No updates found</span>
        ) : check?.extensions.kind === "unavailable" ? (
          <span className="settings__update-state">Check unavailable</span>
        ) : (
          <span className="settings__update-state">Not checked</span>
        )}
      </UpdateStatusRow>
    </div>
  );
}

function InspireUpdateStatus({
  currentVersion,
  check,
  checking,
}: {
  currentVersion: string;
  check: UpdateCheckResponse | null;
  checking: boolean;
}) {
  return (
    <div
      className="settings__update-status"
      aria-live="polite"
      aria-busy={checking}
    >
      <UpdateStatusRow label="INSΠRE">
        <span>
          {currentVersion ? `v${currentVersion}` : "Version unavailable"}
        </span>
        {checking && !check ? (
          <span className="settings__update-state">Checking…</span>
        ) : check?.kind === "available" ? (
          <a
            className="settings__update-link"
            href={check.update.releaseUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            v{check.update.latestVersion} available
          </a>
        ) : check?.kind === "current" ? (
          <span className="settings__update-state">Up to date</span>
        ) : check?.kind === "unreleased" ? (
          <span className="settings__update-state">No release published</span>
        ) : check?.kind === "unavailable" ? (
          <span className="settings__update-state">Check unavailable</span>
        ) : (
          <span className="settings__update-state">Not checked</span>
        )}
      </UpdateStatusRow>
    </div>
  );
}

function UpdateEntry({
  title,
  checked,
  checking,
  checkLabel,
  onCheck,
  children,
}: {
  title: string;
  checked: boolean;
  checking: boolean;
  checkLabel: string;
  onCheck: () => void;
  children: ReactNode;
}) {
  return (
    <div className="settings__update-entry">
      <div className="settings__update-entry-header">
        <span className="settings__field-label">{title}</span>
        <UpdateCheckButton
          label={checkLabel}
          checked={checked}
          checking={checking}
          onClick={onCheck}
        />
      </div>
      {children}
    </div>
  );
}

/** Persistent workbench preferences grouped by user purpose, with secondary
 * install/about/reset utilities kept outside the settings taxonomy. */
export const Settings = memo(function Settings({
  onClose,
  initialCategory = "display",
}: {
  onClose: () => void;
  initialCategory?: SettingsCategoryId;
}) {
  const state = useAppState(
    (source) => ({
      prefs: source.prefs,
      piUpdateCheck: source.piUpdateCheck,
      piUpdateChecking: source.piUpdateChecking,
      piVersion: source.piVersion,
      inspireUpdateCheck: source.inspireUpdateCheck,
      inspireUpdateChecking: source.inspireUpdateChecking,
      version: source.version,
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
  const programmaticScroll = useRef(false);
  const dialogRef = useModalFocus<HTMLDivElement>(true, "settings", onClose);

  const scrollToCategory = useCallback(
    (categoryId: CategoryId, behavior: ScrollBehavior = "smooth") => {
      setActiveCategory(categoryId);
      const target = document.getElementById(`settings-section-${categoryId}`);
      if (!target) return;
      programmaticScroll.current = true;
      target.scrollIntoView({ behavior, block: "start" });
      window.setTimeout(
        () => {
          programmaticScroll.current = false;
        },
        behavior === "smooth" ? 450 : 0,
      );
    },
    [],
  );

  useEffect(() => {
    if (initialCategory === "display") return;
    const frame = window.requestAnimationFrame(() =>
      scrollToCategory(initialCategory, "auto"),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [initialCategory, scrollToCategory]);

  const handleContentScroll = useCallback(() => {
    if (programmaticScroll.current) return;
    const container = contentRef.current;
    if (!container) return;
    const sections = CATEGORIES.map(({ id }) => ({
      id,
      element: document.getElementById(`settings-section-${id}`),
    })).filter(
      (entry): entry is { id: CategoryId; element: HTMLElement } =>
        entry.element !== null,
    );
    if (sections.length === 0) return;
    if (
      container.scrollTop + container.clientHeight >=
      container.scrollHeight - 24
    ) {
      setActiveCategory(sections.at(-1)!.id);
      return;
    }
    const top = container.getBoundingClientRect().top;
    let next = sections[0]!.id;
    for (const section of sections) {
      if (section.element.getBoundingClientRect().top - top <= 96)
        next = section.id;
      else break;
    }
    setActiveCategory(next);
  }, []);

  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings__header">
          <h2 className="settings__title">Settings</h2>
          <button
            type="button"
            className="icon-button settings__close-btn"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
          >
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="settings__layout">
          <nav className="settings__sidebar" aria-label="Settings categories">
            <div className="settings__nav-list">
              {CATEGORIES.map((category) => {
                const active = activeCategory === category.id;
                return (
                  <button
                    type="button"
                    key={category.id}
                    aria-current={active ? "true" : undefined}
                    className={`settings__nav-item ${
                      active ? "settings__nav-item--active" : ""
                    }`}
                    onClick={() => scrollToCategory(category.id)}
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
            <main
              className="settings__content"
              ref={contentRef}
              onScroll={handleContentScroll}
            >
              <Section
                id="display"
                icon={<Palette size={14} />}
                title="Display"
                description="Tune the workbench surface and its reading measure."
              >
                <SettingField
                  label="Theme"
                  description="Choose a light, dark, or system-matched interface."
                >
                  <SegmentedControl
                    label="Theme"
                    value={state.prefs.theme}
                    options={THEMES}
                    onChange={store.setTheme}
                  />
                </SettingField>

                <SettingField
                  label="Color palette"
                  description="Select the accent palette used across the workbench."
                >
                  <SegmentedControl
                    label="Color palette"
                    value={state.prefs.palette}
                    options={PALETTES}
                    onChange={store.setPalette}
                  />
                </SettingField>

                <SettingField
                  label="Content text size"
                  description="Adjust conversation, composer, code, and text preview readability."
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
                  description="Set the maximum width of conversations and the composer."
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
                  description="Show folder names or full paths in the top bar."
                >
                  <SegmentedControl
                    label="Project location"
                    value={state.prefs.projectDisplay}
                    options={PROJECT_DISPLAYS}
                    onChange={store.setProjectDisplay}
                  />
                </SettingField>
              </Section>

              <Section
                id="conversation"
                icon={<ScrollText size={14} />}
                title="Conversation"
                description="Choose how messages and agent activity reveal their detail."
              >
                <SettingField
                  label="Reasoning detail"
                  description="Choose how model reasoning appears in the conversation."
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
                  description="Set the default detail shown for individual tool calls."
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
                  description="Set how grouped activity is loaded and shown by default."
                  stacked
                >
                  <Dropdown
                    label="Activity groups"
                    className="dropdown--field dropdown--described"
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
                  description="Show model and time between assistant turns; otherwise use a divider."
                >
                  <label className="settings-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label="Assistant turn details"
                      checked={state.prefs.assistantRoundDisplay === "details"}
                      onChange={(event) =>
                        store.setAssistantRoundDisplay(
                          event.currentTarget.checked ? "details" : "divider",
                        )
                      }
                    />
                    <span className="settings-switch__track" aria-hidden>
                      <span className="settings-switch__thumb" />
                    </span>
                    <span className="settings-switch__state" aria-hidden>
                      {state.prefs.assistantRoundDisplay === "details"
                        ? "On"
                        : "Off"}
                    </span>
                  </label>
                </SettingField>

                <SettingField
                  label="Desktop send key"
                  description="On mobile, Return always adds a line; only Send submits."
                >
                  <SegmentedControl
                    label="Desktop send key"
                    value={state.prefs.desktopSendKey}
                    options={DESKTOP_SEND_KEYS}
                    onChange={store.setDesktopSendKey}
                  />
                </SettingField>
              </Section>

              <Section
                id="behavior"
                icon={<Compass size={14} />}
                title="Behavior"
                description="Set startup routing and background completion alerts."
              >
                <SettingField
                  label="On launch"
                  description="Open the welcome page or continue the previous session."
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
                  description="Choose how background completions get your attention. Desktop notifications also keep the tab marked."
                  stacked
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
              </Section>

              <Section
                id="updates"
                icon={<RefreshCw size={14} />}
                title="Updates"
              >
                <UpdateEntry
                  title="Pi & Extensions"
                  checked={state.piUpdateCheck !== null}
                  checking={state.piUpdateChecking}
                  checkLabel="Check Pi and extension updates"
                  onCheck={store.checkPiUpdate}
                >
                  <PiUpdateStatus
                    currentVersion={state.piVersion}
                    check={state.piUpdateCheck}
                    checking={state.piUpdateChecking}
                  />
                </UpdateEntry>

                <UpdateEntry
                  title="INSΠRE"
                  checked={state.inspireUpdateCheck !== null}
                  checking={state.inspireUpdateChecking}
                  checkLabel="Check INSΠRE updates"
                  onCheck={store.checkInspireUpdate}
                >
                  <InspireUpdateStatus
                    currentVersion={state.version}
                    check={state.inspireUpdateCheck}
                    checking={state.inspireUpdateChecking}
                  />
                </UpdateEntry>
              </Section>
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
              </div>
              <div className="settings__footer-actions">
                {install === "available" ? (
                  <button
                    type="button"
                    className="settings__utility"
                    onClick={() => void requestInstall()}
                  >
                    <Laptop size={13} aria-hidden />
                    Install app
                  </button>
                ) : null}
                <a
                  className="settings__utility"
                  href="https://github.com/earendil-works/pi"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Pi Coding Agent
                </a>
                <button
                  type="button"
                  className="settings__utility settings__utility--reset"
                  onClick={store.restoreDefaultSettings}
                >
                  Restore defaults
                </button>
              </div>
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
});
