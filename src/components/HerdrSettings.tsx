import { RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { HerdrEnhancementStatus } from "../../shared/herdr";
import { createApi } from "../api";
import { store, useAppState } from "../store";
import { SettingField, SettingsSwitch } from "./SettingsControls";

const readStatus = () => createApi().herdrStatus();

/** The saved choice is independent of the backend's effective-at-startup state.
 * Status is read-only; restarting always goes through the existing Host control. */
export function HerdrSettings({
  getStatus = readStatus,
  onNavigateRestart,
}: {
  getStatus?: () => Promise<HerdrEnhancementStatus>;
  onNavigateRestart?: () => void;
}) {
  const saved = useAppState((state) => state.prefs.herdrEnabled);
  const [status, setStatus] = useState<HerdrEnhancementStatus | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getStatus());
      setError(false);
    } catch {
      setStatus(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [getStatus]);
  useEffect(() => {
    // A dialog can close before the status request settles.
    let active = true;
    void getStatus().then(
      (result) => {
        if (active) {
          setStatus(result);
          setError(false);
          setLoading(false);
        }
      },
      () => {
        if (active) {
          setStatus(null);
          setError(true);
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [getStatus]);

  const canEnable = status?.ready === true;
  const pending = status !== null && saved !== status.enabled;
  const issue =
    status?.issue ??
    (status && !status.supported
      ? "Herdr is not supported on this Host."
      : status && !status.installed
        ? "Herdr is not installed on this Host."
        : status?.compatible === false
          ? "The installed Herdr version is not compatible."
          : null);

  let statusNode: ReactNode = null;
  if (loading || error || issue || pending) {
    statusNode = (
      <div role="status">
        {loading || error || issue ? (
          <div className="settings__field-status-block">
            <span>
              {loading ? "Checking Herdr availability…" : null}
              {!loading && error
                ? "Herdr status is unavailable on this Host."
                : null}
              {!loading && !error && issue ? issue : null}
            </span>
            {error || (status && !status.ready) ? (
              <button
                type="button"
                className="models-text-button"
                aria-label="Recheck availability"
                disabled={loading}
                onClick={() => void refresh()}
              >
                <RefreshCw
                  size={12}
                  className={loading ? "spin" : undefined}
                  aria-hidden
                />{" "}
                Recheck
              </button>
            ) : null}
          </div>
        ) : null}
        {pending ? (
          <div className="settings__field-status-block">
            <span>
              {saved
                ? "Saved. Restart Host to turn on Herdr enhancement. "
                : "Saved. Restart Host to turn off Herdr enhancement. "}
            </span>
            <button
              type="button"
              className="settings__utility"
              aria-label="Review Host restart"
              onClick={() => {
                if (onNavigateRestart) {
                  onNavigateRestart();
                } else {
                  document
                    .getElementById("settings-host-restart")
                    ?.scrollIntoView({ block: "start" });
                }
              }}
            >
              Restart Host…
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <SettingField
      label="Herdr enhancement"
      description="Let Pi use Herdr workspaces and tools. Applies after a Host restart."
      status={statusNode}
    >
      <SettingsSwitch
        label="Herdr enhancement"
        checked={saved}
        disabled={!saved && !canEnable}
        onChange={(checked) => store.setHerdrEnabled(checked)}
      />
    </SettingField>
  );
}
