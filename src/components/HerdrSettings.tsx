import { RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { HerdrEnhancementStatus } from "../../shared/herdr";
import { createApi } from "../api";
import { store, useAppState } from "../store";
import { PiLoader } from "./PiLoader";
import { SettingField, SettingsSwitch } from "./SettingsControls";

const readStatus = () => createApi().herdrStatus();

/** The saved choice is independent of the backend's effective-at-startup state.
 * Status is read-only; restarting always goes through the existing Host control. */
export function HerdrSettings({
  getStatus = readStatus,
  onNavigateRestart,
}: {
  getStatus?: () => Promise<HerdrEnhancementStatus>;
  onNavigateRestart: () => void;
}) {
  const saved = useAppState((state) => state.prefs.herdrEnabled);
  const [status, setStatus] = useState<HerdrEnhancementStatus | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retryRevision, setRetryRevision] = useState(0);
  useEffect(() => {
    // Initial reads and rechecks share the same mounted request lifetime.
    let active = true;
    setLoading(true);
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
  }, [getStatus, retryRevision]);

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
  if (error || issue || pending) {
    statusNode = (
      <div role="status">
        {error || issue ? (
          <div className="settings__field-status-block">
            <span>{error ? "Herdr status is unavailable." : issue}</span>
            {error || (status && !status.ready) ? (
              <button
                type="button"
                className="models-text-button"
                aria-label="Recheck availability"
                disabled={loading}
                aria-busy={loading}
                onClick={() => setRetryRevision((revision) => revision + 1)}
              >
                {loading ? (
                  <PiLoader size={12} aria-hidden />
                ) : (
                  <RefreshCw size={12} aria-hidden />
                )}{" "}
                Recheck
              </button>
            ) : null}
          </div>
        ) : null}
        {pending ? (
          <div className="settings__field-status-block">
            <span>
              {saved
                ? "Herdr will turn on after restart."
                : "Herdr will turn off after restart."}
            </span>
            <button
              type="button"
              className="settings__utility"
              aria-label="Review Host restart"
              onClick={onNavigateRestart}
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
      description="Run Inspire's Pi sessions in Herdr. Requires a Host restart."
      status={statusNode}
    >
      <SettingsSwitch
        label="Herdr enhancement"
        checked={saved}
        disabled={!saved && !canEnable}
        busy={loading}
        onChange={(checked) => store.setHerdrEnabled(checked)}
      />
    </SettingField>
  );
}
