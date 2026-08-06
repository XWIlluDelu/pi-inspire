import { Monitor, Moon, Sun, X } from "lucide-react";
import { useEffect } from "react";
import type {
  AssistantRoundDisplayPreference,
  CompletionAttentionPreference,
  LaunchPreference,
  ProjectDisplayPreference,
  ThemePreference,
  ToolVisibilityPreference,
  VisibilityPreference,
} from "../../shared/contracts";
import { store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { Dropdown } from "./Dropdown";

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

const TOOL_VISIBILITIES: Array<{ value: ToolVisibilityPreference; label: string }> = [
  { value: "hidden", label: "Hidden" },
  { value: "compact", label: "Compact" },
  { value: "collapsed", label: "Collapsed" },
  { value: "expanded", label: "Expanded" },
];

const ASSISTANT_ROUNDS: Array<{ value: AssistantRoundDisplayPreference; label: string }> = [
  { value: "divider", label: "Divider" },
  { value: "details", label: "Details" },
];

const PROJECT_DISPLAYS: Array<{ value: ProjectDisplayPreference; label: string }> = [
  { value: "folder", label: "Folder name" },
  { value: "path", label: "Full path" },
];

const COMPLETION_ATTENTION: Array<{ value: CompletionAttentionPreference; label: string }> = [
  { value: "off", label: "Off" },
  { value: "title", label: "Mark browser title" },
  { value: "desktop", label: "Desktop notification" },
];

/** Settings overlay: persistent preferences only. Per-session model and
 * thinking-level controls stay in the composer. */
export function Settings({ onClose }: { onClose: () => void }) {
  const state = useAppState();
  const dialogRef = useModalFocus<HTMLDivElement>();

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

        <section className="settings__section" aria-label="Transcript">
          <h3 className="settings__section-title">Transcript</h3>
          <div className="settings__field">
            <span className="settings__field-label">Thinking cards</span>
            <Dropdown
              label="Thinking cards"
              className="dropdown--field"
              value={state.prefs.thinkingVisibility}
              options={VISIBILITIES}
              onChange={(value) => store.setThinkingVisibility(value as VisibilityPreference)}
            />
          </div>
          <div className="settings__field">
            <span className="settings__field-label">Tool cards</span>
            <Dropdown
              label="Tool cards"
              className="dropdown--field"
              value={state.prefs.toolVisibility}
              options={TOOL_VISIBILITIES}
              onChange={(value) => store.setToolVisibility(value as ToolVisibilityPreference)}
            />
          </div>
          <div className="settings__field">
            <span className="settings__field-label">Assistant rounds</span>
            <Dropdown
              label="Assistant rounds"
              className="dropdown--field"
              value={state.prefs.assistantRoundDisplay}
              options={ASSISTANT_ROUNDS}
              onChange={(value) => store.setAssistantRoundDisplay(value as AssistantRoundDisplayPreference)}
            />
          </div>
        </section>

        <section className="settings__section" aria-label="Completion attention">
          <h3 className="settings__section-title">Completion attention</h3>
          <div className="settings__field settings__field--stacked">
            <div>
              <span className="settings__field-label">When unseen work ends</span>
              <p className="settings__field-help">
                Off does nothing. Title marks the tab until you view the session. Desktop sends one privacy-safe
                notification for background or hidden-tab completion; permission is requested only when you choose it.
              </p>
            </div>
            <Dropdown
              label="Completion attention"
              className="dropdown--field"
              value={state.prefs.completionAttention}
              options={COMPLETION_ATTENTION}
              onChange={(value) => void store.setCompletionAttention(value as CompletionAttentionPreference)}
            />
          </div>
        </section>

        <section className="settings__section" aria-label="Startup">
          <h3 className="settings__section-title">Startup</h3>
          <div className="settings__field">
            <span className="settings__field-label">On launch</span>
            <Dropdown
              label="On launch"
              className="dropdown--field"
              value={state.prefs.launch}
              options={[
                { value: "welcome", label: "Show welcome page" },
                { value: "continue", label: "Continue previous session" },
              ]}
              onChange={(value) => store.setLaunch(value as LaunchPreference)}
            />
          </div>
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
