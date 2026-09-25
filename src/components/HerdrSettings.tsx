import { useCallback, useEffect, useState } from "react";
import type { HerdrEnhancementStatus } from "../../shared/herdr";
import { createApi } from "../api";
import { store, useAppState } from "../store";

const readStatus = () => createApi().herdrStatus();

/** The saved choice is independent of the backend's effective-at-startup state.
 * Status is read-only; restarting always goes through the existing Host control. */
export function HerdrSettings({
  getStatus = readStatus,
}: {
  getStatus?: () => Promise<HerdrEnhancementStatus>;
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

  const canEnable =
    status?.supported === true &&
    status.installed &&
    status.compatible !== false;
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
  return (
    <div className="settings__field">
      <div className="settings__field-info">
        <span className="settings__field-label">Herdr enhancement</span>
        <p className="settings__field-help">
          Give Pi access to Herdr workspaces and tools. Changes take effect
          after a Host restart.
        </p>
        <p className="settings__field-help" role="status">
          {loading ? "Checking Herdr availability…" : null}
          {!loading && error
            ? "Herdr status is unavailable on this Host."
            : null}
          {!loading && !error && issue ? issue : null}
          {pending
            ? saved
              ? " Saved. Restart Host to turn on Herdr enhancement."
              : " Saved. Restart Host to turn off Herdr enhancement."
            : null}
        </p>
        {pending ? (
          <a className="settings__utility" href="#settings-host-restart">
            Review Host restart
          </a>
        ) : null}
        {error ? (
          <button
            type="button"
            className="button"
            onClick={() => void refresh()}
          >
            Recheck availability
          </button>
        ) : null}
      </div>
      <div className="settings__field-control">
        <label className="settings-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Herdr enhancement"
            checked={saved}
            // Turning off must remain possible even when Herdr or status is unavailable.
            disabled={!saved && !canEnable}
            onChange={(event) =>
              store.setHerdrEnabled(event.currentTarget.checked)
            }
          />
          <span className="settings-switch__track" aria-hidden>
            <span className="settings-switch__thumb" />
          </span>
          <span className="settings-switch__state" aria-hidden>
            {saved ? "On" : "Off"}
          </span>
        </label>
      </div>
    </div>
  );
}
