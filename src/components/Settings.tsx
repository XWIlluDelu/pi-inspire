import { Monitor, Moon, Sun, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import {
  ASSISTANT_ROUND_DISPLAYS,
  TOOL_VISIBILITY_PREFERENCES,
  VISIBILITY_PREFERENCES,
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

/** Settings overlay: persistent preferences only. Per-session model and
 * thinking-level controls stay in the composer. */
export function Settings({ onClose }: { onClose: () => void }) {
  const state = useAppState();
  const install = useSyncExternalStore(
    subscribeInstallAvailability,
    installAvailability,
  );
  const dialogRef = useModalFocus<HTMLDivElement>(true, "settings", onClose);

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
            className="icon-button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
          >
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
            <span className="settings__field-label">Color palette</span>
            <div className="segmented" role="group" aria-label="Color palette">
              {PALETTES.map(({ value, label }) => (
                <button
                  type="button"
                  key={value}
                  className={`segmented__item ${(state.prefs.palette ?? "amber") === value ? "segmented__item--active" : ""}`}
                  onClick={() => store.setPalette(value)}
                  aria-pressed={(state.prefs.palette ?? "amber") === value}
                >
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="settings__field">
            <span className="settings__field-label">Project location</span>
            <div
              className="segmented"
              role="group"
              aria-label="Project location"
            >
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
              onChange={(value) =>
                store.setThinkingVisibility(value as VisibilityPreference)
              }
            />
          </div>
          <div className="settings__field">
            <span className="settings__field-label">Tool cards</span>
            <Dropdown
              label="Tool cards"
              className="dropdown--field"
              value={state.prefs.toolVisibility}
              options={TOOL_VISIBILITIES}
              onChange={(value) =>
                store.setToolVisibility(value as ToolVisibilityPreference)
              }
            />
          </div>
          <div className="settings__field">
            <span className="settings__field-label">Assistant rounds</span>
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
        </section>

        <section
          className="settings__section"
          aria-label="Completion attention"
        >
          <h3 className="settings__section-title">Completion attention</h3>
          <div className="settings__field settings__field--stacked">
            <div>
              <span className="settings__field-label">
                When unseen work ends
              </span>
              <p className="settings__field-help">
                Off does nothing. Title marks the tab until you view the
                session. Desktop sends one privacy-safe notification for
                background or hidden-tab completion; permission is requested
                only when you choose it.
              </p>
            </div>
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

        <section className="settings__section" aria-label="Install">
          <h3 className="settings__section-title">Install</h3>
          {install === "available" ? (
            <div className="settings__field">
              <span className="settings__field-label">Install as an app</span>
              <button
                type="button"
                className="button"
                onClick={() => void requestInstall()}
              >
                Install INSΠRE
              </button>
            </div>
          ) : (
            <div className="settings__field settings__field--stacked">
              <div>
                <span className="settings__field-label">Install as an app</span>
                <p className="settings__field-help">
                  {install === "installed"
                    ? "Inspire is installed and running in its own window."
                    : "Inspire can run installed in its own window, without browser chrome. Your browser offers installation from its address bar or menu."}
                </p>
              </div>
            </div>
          )}
        </section>

        <section className="settings__section" aria-label="About">
          <h3 className="settings__section-title">About</h3>
          <p className="settings__about">
            INSΠRE {state.version ? <code>v{state.version}</code> : null} — a
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
        </section>
      </div>
    </div>
  );
}
