import { Monitor, Moon, Sun, X } from "lucide-react";
import { useEffect } from "react";
import type {
  LaunchPreference,
  ProjectDisplayPreference,
  ThemePreference,
  VisibilityPreference,
} from "../../shared/contracts";
import { store, useAppState } from "../store";

const THEMES: Array<{ value: ThemePreference; label: string; icon: React.ReactNode }> = [
  { value: "light", label: "Light", icon: <Sun size={13} aria-hidden /> },
  { value: "dark", label: "Dark", icon: <Moon size={13} aria-hidden /> },
  { value: "system", label: "System", icon: <Monitor size={13} aria-hidden /> },
];

const VISIBILITIES: Array<{ value: VisibilityPreference; label: string }> = [
  { value: "hidden", label: "Hidden" },
  { value: "collapsed", label: "Collapsed" },
  { value: "expanded", label: "Expanded" },
];

const PROJECT_DISPLAYS: Array<{ value: ProjectDisplayPreference; label: string }> = [
  { value: "folder", label: "Folder name" },
  { value: "path", label: "Full path" },
];

/** Settings overlay: persistent preferences only. Per-session model and
 * thinking-level controls stay in the composer. */
export function Settings({ onClose }: { onClose: () => void }) {
  const state = useAppState();

  useEffect(() => {
    // Capture phase: the dialog must own Escape before the global abort
    // shortcut (which honors defaultPrevented) can see it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        className="dialog settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings__header">
          <h2 className="settings__title">Settings</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings" title="Close">
            <X size={15} aria-hidden />
          </button>
        </header>

        <section className="settings__section" aria-label="Appearance">
          <h3 className="settings__section-title">Appearance</h3>
          <div className="settings__field">
            <span className="settings__field-label">Theme</span>
            <div className="segmented" role="group" aria-label="Theme">
              {THEMES.map((theme) => (
                <button
                  type="button"
                  key={theme.value}
                  className={`segmented__item ${state.prefs.theme === theme.value ? "segmented__item--active" : ""}`}
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
          <div className="settings__field">
            <span className="settings__field-label">Project location</span>
            <div className="segmented" role="group" aria-label="Project location">
              {PROJECT_DISPLAYS.map(({ value, label }) => (
                <button
                  type="button"
                  key={value}
                  className={`segmented__item ${state.prefs.projectDisplay === value ? "segmented__item--active" : ""}`}
                  onClick={() => store.setProjectDisplay(value)}
                  aria-pressed={state.prefs.projectDisplay === value}
                >
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings__section" aria-label="Cards">
          <h3 className="settings__section-title">Cards</h3>
          <label className="settings__field">
            <span className="settings__field-label">Thinking cards</span>
            <select
              value={state.prefs.thinkingVisibility}
              onChange={(event) => store.setThinkingVisibility(event.target.value as VisibilityPreference)}
            >
              {VISIBILITIES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings__field">
            <span className="settings__field-label">Tool cards</span>
            <select
              value={state.prefs.toolVisibility}
              onChange={(event) => store.setToolVisibility(event.target.value as VisibilityPreference)}
            >
              {VISIBILITIES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="settings__section" aria-label="Startup">
          <h3 className="settings__section-title">Startup</h3>
          <label className="settings__field">
            <span className="settings__field-label">On launch</span>
            <select
              value={state.prefs.launch}
              onChange={(event) => store.setLaunch(event.target.value as LaunchPreference)}
            >
              <option value="welcome">Show welcome page</option>
              <option value="continue">Continue previous session</option>
            </select>
          </label>
        </section>

        <section className="settings__section" aria-label="About">
          <h3 className="settings__section-title">About</h3>
          <p className="settings__about">
            insπre {state.version ? <code>v{state.version}</code> : null} — a local workbench for{" "}
            <a href="https://github.com/earendil-works/pi" target="_blank" rel="noreferrer noopener">
              Pi Coding Agent
            </a>
            . Pi remains the runtime and session authority.
          </p>
        </section>
      </div>
    </div>
  );
}
