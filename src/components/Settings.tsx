import { ArrowLeft, Monitor, Moon, Sun } from "lucide-react";
import type { LaunchPreference, ThemePreference, VisibilityPreference } from "../../shared/contracts";
import { store, useAppState } from "../store";

const THEMES: Array<{ value: ThemePreference; label: string; icon: React.ReactNode }> = [
  { value: "light", label: "Light", icon: <Sun size={13} aria-hidden /> },
  { value: "dark", label: "Dark", icon: <Moon size={13} aria-hidden /> },
  { value: "system", label: "System", icon: <Monitor size={13} aria-hidden /> },
];

const VISIBILITIES: VisibilityPreference[] = ["hidden", "collapsed", "expanded"];

/** Draft settings page: persistent preferences only. Per-session model and
 * thinking-level controls stay in the composer. */
export function Settings({ onClose }: { onClose: () => void }) {
  const state = useAppState();

  return (
    <div className="settings">
      <div className="settings__page">
        <header className="settings__header">
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close settings"
            title="Back to conversation"
          >
            <ArrowLeft size={15} aria-hidden />
          </button>
          <h2 className="settings__title">Settings</h2>
          <span className="chip chip--muted">Draft</span>
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
          <label className="settings__field">
            <span className="settings__field-label">Reading font</span>
            <select
              value={state.prefs.readingSerif ? "serif" : "sans"}
              onChange={(event) => store.setReadingSerif(event.target.value === "serif")}
            >
              <option value="sans">sans</option>
              <option value="serif">serif</option>
            </select>
          </label>
        </section>

        <section className="settings__section" aria-label="Cards">
          <h3 className="settings__section-title">Cards</h3>
          <label className="settings__field">
            <span className="settings__field-label">Thinking cards</span>
            <select
              value={state.prefs.thinkingVisibility}
              onChange={(event) => store.setThinkingVisibility(event.target.value as VisibilityPreference)}
            >
              {VISIBILITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
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
              {VISIBILITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
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
              <option value="welcome">welcome</option>
              <option value="continue">continue</option>
            </select>
          </label>
        </section>
      </div>
    </div>
  );
}
