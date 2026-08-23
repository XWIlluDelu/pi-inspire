import {
  Bell,
  Compass,
  Laptop,
  Monitor,
  Moon,
  Palette,
  ScrollText,
  Search,
  SlidersHorizontal,
  Sun,
  X,
} from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ACTIVITY_FOLD_VISIBILITIES,
  ASSISTANT_ROUND_DISPLAYS,
  TOOL_VISIBILITY_PREFERENCES,
  VISIBILITY_PREFERENCES,
  type ActivityFoldVisibilityPreference,
  type AssistantRoundDisplayPreference,
  type CompletionAttentionPreference,
  type LaunchPreference,
  type PalettePreference,
  type ProjectDisplayPreference,
  type ThemePreference,
  type ToolVisibilityPreference,
  type VisibilityPreference,
} from "../../shared/contracts";
import {
  installAvailability,
  requestInstall,
  subscribeInstallAvailability,
} from "../install-app";
import { store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { Dropdown } from "./Dropdown";

const THEMES: Array<{
  value: ThemePreference;
  label: string;
  icon: React.ReactNode;
}> = [
  { value: "light", label: "Light", icon: <Sun size={13} aria-hidden /> },
  { value: "dark", label: "Dark", icon: <Moon size={13} aria-hidden /> },
  { value: "system", label: "System", icon: <Monitor size={13} aria-hidden /> },
];

const PALETTES: Array<{
  value: PalettePreference;
  label: string;
}> = [
  { value: "amber", label: "Amber" },
  { value: "teal", label: "Jade" },
];

function preferenceLabel(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

const VISIBILITIES: Array<{ value: VisibilityPreference; label: string }> =
  VISIBILITY_PREFERENCES.map((value) => ({
    value,
    label: preferenceLabel(value),
  }));

const TOOL_VISIBILITIES: Array<{
  value: ToolVisibilityPreference;
  label: string;
}> = TOOL_VISIBILITY_PREFERENCES.map((value) => ({
  value,
  label: preferenceLabel(value),
}));

const ACTIVITY_FOLDS: Array<{
  value: ActivityFoldVisibilityPreference;
  label: string;
}> = ACTIVITY_FOLD_VISIBILITIES.map((value) => ({
  value,
  label: preferenceLabel(value),
}));

const ASSISTANT_ROUNDS: Array<{
  value: AssistantRoundDisplayPreference;
  label: string;
}> = ASSISTANT_ROUND_DISPLAYS.map((value) => ({
  value,
  label: preferenceLabel(value),
}));

const PROJECT_DISPLAYS: Array<{
  value: ProjectDisplayPreference;
  label: string;
}> = [
  { value: "folder", label: "Folder name" },
  { value: "path", label: "Full path" },
];

const COMPLETION_ATTENTION: Array<{
  value: CompletionAttentionPreference;
  label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "title", label: "Mark browser title" },
  { value: "desktop", label: "Desktop notification" },
];

interface CategoryMeta {
  id: string;
  label: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  keywords: string[];
}

const CATEGORIES: CategoryMeta[] = [
  {
    id: "appearance",
    label: "Appearance",
    icon: <Palette size={14} aria-hidden />,
    title: "Appearance",
    description:
      "Theme luminosity, accent color palette, and workspace project path display.",
    keywords: [
      "appearance",
      "theme",
      "light",
      "dark",
      "system",
      "color",
      "palette",
      "amber",
      "jade",
      "teal",
      "project",
      "location",
      "path",
      "folder",
    ],
  },
  {
    id: "transcript",
    label: "Transcript",
    icon: <ScrollText size={14} aria-hidden />,
    title: "Transcript",
    description:
      "Display visibility and folding behavior for thinking cards, tool executions, and assistant turns.",
    keywords: [
      "transcript",
      "thinking",
      "tool",
      "activity",
      "folds",
      "assistant",
      "rounds",
      "dynamic",
      "expanded",
      "compact",
      "collapsed",
      "hidden",
      "divider",
      "details",
    ],
  },
  {
    id: "attention",
    label: "Attention",
    icon: <Bell size={14} aria-hidden />,
    title: "Completion attention",
    description:
      "Notification and tab attention signals when background agent execution finishes.",
    keywords: [
      "attention",
      "notification",
      "completion",
      "desktop",
      "title",
      "tab",
      "background",
      "unseen",
    ],
  },
  {
    id: "startup",
    label: "Startup",
    icon: <Compass size={14} aria-hidden />,
    title: "Startup",
    description:
      "Default session routing and workspace recovery behavior when launching the workbench.",
    keywords: [
      "startup",
      "launch",
      "welcome",
      "continue",
      "session",
      "open",
      "restore",
    ],
  },
  {
    id: "install",
    label: "Install",
    icon: <Laptop size={14} aria-hidden />,
    title: "Install",
    description:
      "Standalone Progressive Web App integration and standalone windowing.",
    keywords: [
      "install",
      "app",
      "pwa",
      "desktop",
      "window",
      "chrome",
      "standalone",
    ],
  },
  {
    id: "about",
    label: "About",
    icon: <SlidersHorizontal size={14} aria-hidden />,
    title: "About",
    description:
      "INSΠRE workbench architecture, version manifest, and upstream agent authority.",
    keywords: ["about", "version", "pi", "agent", "workbench", "system"],
  },
];

/**
 * Settings overlay: persistent preferences organized in modular semantic blocks
 * with dual-pane category navigation, instant search, and full responsive support.
 */
export function Settings({ onClose }: { onClose: () => void }) {
  const state = useAppState();
  const install = useSyncExternalStore(
    subscribeInstallAvailability,
    installAvailability,
  );
  const [activeCategory, setActiveCategory] = useState<string>("appearance");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const contentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isProgrammaticScroll = useRef(false);
  const pendingCategoryScroll = useRef<string | null>(null);
  const handleModalEscape = useCallback(() => {
    if (searchQuery) {
      setSearchQuery("");
      searchInputRef.current?.focus();
      return;
    }
    onClose();
  }, [onClose, searchQuery]);
  const dialogRef = useModalFocus<HTMLDivElement>(
    true,
    "settings",
    handleModalEscape,
  );

  const queryNormalized = searchQuery.trim().toLowerCase();

  // Determine which categories match the query
  const visibleCategories = useMemo(() => {
    if (!queryNormalized) return CATEGORIES;
    return CATEGORIES.filter((cat) => {
      const titleMatch = cat.title.toLowerCase().includes(queryNormalized);
      const descMatch = cat.description.toLowerCase().includes(queryNormalized);
      const kwMatch = cat.keywords.some((k) => k.includes(queryNormalized));
      return titleMatch || descMatch || kwMatch;
    });
  }, [queryNormalized]);

  // Scroll to selected category
  const scrollToCategory = useCallback((categoryId: string) => {
    setActiveCategory(categoryId);
    const target = document.getElementById(`settings-section-${categoryId}`);
    if (target && contentRef.current) {
      isProgrammaticScroll.current = true;
      if (typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      setTimeout(() => {
        isProgrammaticScroll.current = false;
      }, 450);
    }
  }, []);

  useLayoutEffect(() => {
    if (queryNormalized || !pendingCategoryScroll.current) return;
    const categoryId = pendingCategoryScroll.current;
    pendingCategoryScroll.current = null;
    scrollToCategory(categoryId);
  }, [queryNormalized, scrollToCategory]);

  // Update active category on manual scroll
  const handleContentScroll = useCallback(() => {
    if (isProgrammaticScroll.current || queryNormalized) return;
    const container = contentRef.current;
    if (!container) return;

    const sections = CATEGORIES.map((cat) => ({
      id: cat.id,
      element: document.getElementById(`settings-section-${cat.id}`),
    })).filter(
      (entry): entry is { id: string; element: HTMLElement } =>
        entry.element !== null,
    );

    if (sections.length === 0) return;

    // When scrolled to the bottom of the container, snap active state to the last visible category
    const isAtBottom =
      container.scrollTop + container.clientHeight >=
      container.scrollHeight - 32;
    if (isAtBottom) {
      const lastSection = sections[sections.length - 1];
      if (lastSection && lastSection.id !== activeCategory) {
        setActiveCategory(lastSection.id);
      }
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    let closestId = sections[0]!.id;
    let minDistance = Infinity;

    for (const { id, element } of sections) {
      const rect = element.getBoundingClientRect();
      const relativeTop = rect.top - containerTop;
      // Section is considered active when its header is above or near the top of the viewing area
      if (relativeTop <= 110) {
        const distance = Math.abs(relativeTop);
        if (distance < minDistance) {
          minDistance = distance;
          closestId = id;
        }
      }
    }

    if (closestId !== activeCategory) {
      setActiveCategory(closestId);
    }
  }, [activeCategory, queryNormalized]);

  const handleCategorySelection = useCallback(
    (categoryId: string) => {
      if (queryNormalized) {
        setActiveCategory(categoryId);
        pendingCategoryScroll.current = categoryId;
        setSearchQuery("");
        return;
      }
      scrollToCategory(categoryId);
    },
    [queryNormalized, scrollToCategory],
  );

  const isCategoryVisible = (catId: string) => {
    if (!queryNormalized) return true;
    return visibleCategories.some((c) => c.id === catId);
  };

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
          <div className="settings__header-left">
            <h2 className="settings__title">Settings</h2>
          </div>

          <div className="settings__header-actions">
            <div className="settings__search-box">
              <Search size={13} className="settings__search-icon" aria-hidden />
              <input
                ref={searchInputRef}
                type="text"
                className="settings__search-input"
                placeholder="Search settings..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search settings"
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="settings__search-clear"
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  title="Clear search"
                >
                  <X size={12} aria-hidden />
                </button>
              ) : (
                <span className="settings__search-hint" aria-hidden>
                  Esc
                </span>
              )}
            </div>

            <button
              type="button"
              className="icon-button settings__close-btn"
              onClick={onClose}
              aria-label="Close settings"
              title="Close"
            >
              <X size={15} aria-hidden />
            </button>
          </div>
        </header>

        <div className="settings__layout">
          <nav className="settings__sidebar" aria-label="Settings categories">
            <div className="settings__nav-list">
              {CATEGORIES.map((cat) => {
                const isMatch = visibleCategories.some((c) => c.id === cat.id);
                const isActive = activeCategory === cat.id && !queryNormalized;
                return (
                  <button
                    type="button"
                    key={cat.id}
                    id={`settings-category-${cat.id}`}
                    aria-current={isActive ? "true" : undefined}
                    className={`settings__nav-item ${
                      isActive ? "settings__nav-item--active" : ""
                    } ${!isMatch ? "settings__nav-item--dimmed" : ""}`}
                    onClick={() => handleCategorySelection(cat.id)}
                  >
                    <span className="settings__nav-icon">{cat.icon}</span>
                    <span className="settings__nav-label">{cat.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="settings__sidebar-footer">
              <div className="settings__version-badge">
                <span className="settings__version-dot" aria-hidden />
                <span>
                  INSΠRE{" "}
                  {state.version ? `v${state.version}` : "Version unavailable"}
                </span>
              </div>
            </div>
          </nav>

          <main
            className="settings__content"
            ref={contentRef}
            onScroll={handleContentScroll}
          >
            {visibleCategories.length === 0 ? (
              <div className="settings__empty">
                <SlidersHorizontal
                  size={28}
                  className="settings__empty-icon"
                  aria-hidden
                />
                <h4 className="settings__empty-title">No settings found</h4>
                <p className="settings__empty-text">
                  No preferences match &ldquo;{searchQuery}&rdquo;
                </p>
                <button
                  type="button"
                  className="button settings__empty-action"
                  onClick={() => setSearchQuery("")}
                >
                  Clear search
                </button>
              </div>
            ) : null}

            {/* Appearance Section */}
            {isCategoryVisible("appearance") && (
              <section
                id="settings-section-appearance"
                className="settings__section"
                aria-label="Appearance"
              >
                <div className="settings__section-header">
                  <div className="settings__section-title-wrap">
                    <span className="settings__section-icon" aria-hidden>
                      <Palette size={14} />
                    </span>
                    <h3 className="settings__section-title">Appearance</h3>
                  </div>
                  <p className="settings__section-desc">
                    Theme luminosity, accent color palette, and workspace
                    project path representation.
                  </p>
                </div>

                <div className="settings__card">
                  <div className="settings__field">
                    <div className="settings__field-info">
                      <span className="settings__field-label">Theme</span>
                      <p className="settings__field-help">
                        Choose light, dark, or follow system appearance.
                      </p>
                    </div>
                    <div className="settings__field-control">
                      <div
                        className="segmented"
                        role="group"
                        aria-label="Theme"
                      >
                        {THEMES.map((theme) => (
                          <button
                            type="button"
                            key={theme.value}
                            className={`segmented__item ${
                              state.prefs.theme === theme.value
                                ? "segmented__item--active"
                                : ""
                            }`}
                            onClick={() => store.setTheme(theme.value)}
                            title={theme.label}
                            aria-pressed={state.prefs.theme === theme.value}
                          >
                            {theme.icon}
                            <span>{theme.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="settings__field">
                    <div className="settings__field-info">
                      <span className="settings__field-label">
                        Color palette
                      </span>
                      <p className="settings__field-help">
                        Select identity accent and workbench neutral tones.
                      </p>
                    </div>
                    <div className="settings__field-control">
                      <div
                        className="segmented"
                        role="group"
                        aria-label="Color palette"
                      >
                        {PALETTES.map(({ value, label }) => (
                          <button
                            type="button"
                            key={value}
                            className={`segmented__item ${
                              (state.prefs.palette ?? "amber") === value
                                ? "segmented__item--active"
                                : ""
                            }`}
                            onClick={() => store.setPalette(value)}
                            aria-pressed={
                              (state.prefs.palette ?? "amber") === value
                            }
                          >
                            <span>{label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="settings__field">
                    <div className="settings__field-info">
                      <span className="settings__field-label">
                        Project location
                      </span>
                      <p className="settings__field-help">
                        Display workspace folder name or full system path in
                        topbar.
                      </p>
                    </div>
                    <div className="settings__field-control">
                      <div
                        className="segmented"
                        role="group"
                        aria-label="Project location"
                      >
                        {PROJECT_DISPLAYS.map(({ value, label }) => (
                          <button
                            type="button"
                            key={value}
                            className={`segmented__item ${
                              state.prefs.projectDisplay === value
                                ? "segmented__item--active"
                                : ""
                            }`}
                            onClick={() => store.setProjectDisplay(value)}
                            aria-pressed={state.prefs.projectDisplay === value}
                          >
                            <span>{label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* Transcript Section */}
            {isCategoryVisible("transcript") && (
              <section
                id="settings-section-transcript"
                className="settings__section"
                aria-label="Transcript"
              >
                <div className="settings__section-header">
                  <div className="settings__section-title-wrap">
                    <span className="settings__section-icon" aria-hidden>
                      <ScrollText size={14} />
                    </span>
                    <h3 className="settings__section-title">Transcript</h3>
                  </div>
                  <p className="settings__section-desc">
                    Visibility rules and folding behavior for LLM thinking, tool
                    cards, and assistant turns.
                  </p>
                </div>

                <div className="settings__card">
                  <div className="settings__field">
                    <div className="settings__field-info">
                      <span className="settings__field-label">
                        Thinking cards
                      </span>
                      <p className="settings__field-help">
                        How model reasoning blocks unfold in the conversation
                        flow.
                      </p>
                    </div>
                    <div className="settings__field-control">
                      <Dropdown
                        label="Thinking cards"
                        className="dropdown--field"
                        value={state.prefs.thinkingVisibility}
                        options={VISIBILITIES}
                        onChange={(value) =>
                          store.setThinkingVisibility(
                            value as VisibilityPreference,
                          )
                        }
                      />
                    </div>
                  </div>

                  <div className="settings__field">
                    <div className="settings__field-info">
                      <span className="settings__field-label">Tool cards</span>
                      <p className="settings__field-help">
                        Presentation density for tool call inputs and results.
                      </p>
                    </div>
                    <div className="settings__field-control">
                      <Dropdown
                        label="Tool cards"
                        className="dropdown--field"
                        value={state.prefs.toolVisibility}
                        options={TOOL_VISIBILITIES}
                        onChange={(value) =>
                          store.setToolVisibility(
                            value as ToolVisibilityPreference,
                          )
                        }
                      />
                    </div>
                  </div>

                  <div className="settings__field">
                    <div className="settings__field-info">
                      <span className="settings__field-label">
                        Activity folds
                      </span>
                      <p className="settings__field-help">
                        Folding behavior for consecutive multi-step tool runs.
                      </p>
                    </div>
                    <div className="settings__field-control">
                      <Dropdown
                        label="Activity folds"
                        className="dropdown--field"
                        value={state.prefs.activityFoldVisibility ?? "dynamic"}
                        options={ACTIVITY_FOLDS}
                        onChange={(value) =>
                          store.setActivityFoldVisibility(
                            value as ActivityFoldVisibilityPreference,
                          )
                        }
                      />
                    </div>
                  </div>

                  <div className="settings__field">
                    <div className="settings__field-info">
                      <span className="settings__field-label">
                        Assistant rounds
                      </span>
                      <p className="settings__field-help">
                        Visual separation between consecutive turns in the
                        transcript.
                      </p>
                    </div>
                    <div className="settings__field-control">
                      <Dropdown
                        label="Assistant rounds"
                        className="dropdown--field"
                        value={state.prefs.assistantRoundDisplay}
                        options={ASSISTANT_ROUNDS}
                        onChange={(value) =>
                          store.setAssistantRoundDisplay(
                            value as AssistantRoundDisplayPreference,
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* Completion Attention Section */}
            {isCategoryVisible("attention") && (
              <section
                id="settings-section-attention"
                className="settings__section"
                aria-label="Completion attention"
              >
                <div className="settings__section-header">
                  <div className="settings__section-title-wrap">
                    <span className="settings__section-icon" aria-hidden>
                      <Bell size={14} />
                    </span>
                    <h3 className="settings__section-title">
                      Completion attention
                    </h3>
                  </div>
                  <p className="settings__section-desc">
                    Keep track of long-running sessions when multitasking or
                    working in background tabs.
                  </p>
                </div>

                <div className="settings__card">
                  <div className="settings__field settings__field--stacked">
                    <div className="settings__field-info">
                      <span className="settings__field-label">
                        When unseen work ends
                      </span>
                      <p className="settings__field-help">
                        Off does nothing. Title marks the tab until you view the
                        session. Desktop sends one privacy-safe notification for
                        background or hidden-tab completion; permission is
                        requested only when you choose it.
                      </p>
                    </div>
                    <div className="settings__field-control">
                      <Dropdown
                        label="Completion attention"
                        className="dropdown--field"
                        value={state.prefs.completionAttention}
                        options={COMPLETION_ATTENTION}
                        onChange={(value) =>
                          void store.setCompletionAttention(
                            value as CompletionAttentionPreference,
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* Startup Section */}
            {isCategoryVisible("startup") && (
              <section
                id="settings-section-startup"
                className="settings__section"
                aria-label="Startup"
              >
                <div className="settings__section-header">
                  <div className="settings__section-title-wrap">
                    <span className="settings__section-icon" aria-hidden>
                      <Compass size={14} />
                    </span>
                    <h3 className="settings__section-title">Startup</h3>
                  </div>
                  <p className="settings__section-desc">
                    Initial screen routing and session recovery preferences on
                    startup.
                  </p>
                </div>

                <div className="settings__card">
                  <div className="settings__field">
                    <div className="settings__field-info">
                      <span className="settings__field-label">On launch</span>
                      <p className="settings__field-help">
                        Choose whether to show the welcome dashboard or resume
                        the previous session.
                      </p>
                    </div>
                    <div className="settings__field-control">
                      <Dropdown
                        label="On launch"
                        className="dropdown--field"
                        value={state.prefs.launch}
                        options={[
                          { value: "welcome", label: "Show welcome page" },
                          {
                            value: "continue",
                            label: "Continue previous session",
                          },
                        ]}
                        onChange={(value) =>
                          store.setLaunch(value as LaunchPreference)
                        }
                      />
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* Install Section */}
            {isCategoryVisible("install") && (
              <section
                id="settings-section-install"
                className="settings__section"
                aria-label="Install"
              >
                <div className="settings__section-header">
                  <div className="settings__section-title-wrap">
                    <span className="settings__section-icon" aria-hidden>
                      <Laptop size={14} />
                    </span>
                    <h3 className="settings__section-title">Install</h3>
                  </div>
                  <p className="settings__section-desc">
                    Run INSΠRE as an isolated desktop application with dedicated
                    windowing.
                  </p>
                </div>

                <div className="settings__card">
                  {install === "available" ? (
                    <div className="settings__field">
                      <div className="settings__field-info">
                        <span className="settings__field-label">
                          Install as an app
                        </span>
                        <p className="settings__field-help">
                          Installs a standalone desktop progressive web app with
                          custom window controls.
                        </p>
                      </div>
                      <div className="settings__field-control">
                        <button
                          type="button"
                          className="button"
                          onClick={() => void requestInstall()}
                        >
                          Install INSΠRE
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="settings__field settings__field--stacked">
                      <div className="settings__field-info">
                        <span className="settings__field-label">
                          Install as an app
                        </span>
                        <p className="settings__field-help">
                          {install === "installed"
                            ? "Inspire is installed and running in its own window."
                            : "Inspire can run installed in its own window, without browser chrome. Your browser offers installation from its address bar or menu."}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* About Section */}
            {isCategoryVisible("about") && (
              <section
                id="settings-section-about"
                className="settings__section"
                aria-label="About"
              >
                <div className="settings__section-header">
                  <div className="settings__section-title-wrap">
                    <span className="settings__section-icon" aria-hidden>
                      <SlidersHorizontal size={14} />
                    </span>
                    <h3 className="settings__section-title">About</h3>
                  </div>
                  <p className="settings__section-desc">
                    System runtime details, engine manifest, and upstream
                    architecture.
                  </p>
                </div>

                <div className="settings__card settings__card--about">
                  <div className="settings__about-header">
                    <div className="settings__about-identity">
                      <span className="settings__about-name">INSΠRE</span>
                      {state.version ? (
                        <span className="settings__about-version">
                          v{state.version}
                        </span>
                      ) : null}
                    </div>
                    <span className="settings__about-tag">
                      Scientific Workbench
                    </span>
                  </div>

                  <p className="settings__about">
                    INSΠRE{" "}
                    {state.version ? <code>v{state.version}</code> : null} — a
                    local workbench for{" "}
                    <a
                      href="https://github.com/earendil-works/pi"
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Pi Coding Agent
                    </a>
                    . Pi remains the runtime and session authority.
                  </p>
                </div>
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
