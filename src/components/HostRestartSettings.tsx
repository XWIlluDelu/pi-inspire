import { RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { HostRestartScope } from "../../shared/host-restart";
import { hostRestartClient } from "../controllers/host-restart-controller";
import { useModalFocus } from "../use-modal-focus";
import { PiLoader } from "./PiLoader";
import { SettingField } from "./SettingsControls";

function RestartConfirmation({
  scope,
  interruptWork,
  onClose,
  onConfirm,
}: {
  scope: HostRestartScope;
  interruptWork: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useModalFocus<HTMLDivElement>(true, "host-restart", onClose);
  return createPortal(
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        ref={ref}
        className="dialog host-restart-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="host-restart-title"
        aria-describedby="host-restart-description"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog__title" id="host-restart-title">
          {interruptWork
            ? scope === "all"
              ? "Stop work and restart all?"
              : "Stop work and restart Host?"
            : scope === "all"
              ? "Restart all?"
              : "Restart Host?"}
        </h2>
        <p className="dialog__message" id="host-restart-description">
          {interruptWork
            ? scope === "all"
              ? "This will stop all active Pi work, discard Pending messages, end all project terminal processes, and briefly disconnect the page."
              : "This will stop all active Pi work, discard Pending messages, and briefly disconnect the page. Project terminals keep running."
            : scope === "all"
              ? "This will end all project terminal processes and briefly disconnect the page."
              : "The page will briefly disconnect."}
        </p>
        <div className="host-restart__actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={onConfirm}
          >
            {interruptWork
              ? scope === "all"
                ? "Stop work and restart all"
                : "Stop work and restart Host"
              : scope === "all"
                ? "Restart all"
                : "Restart Host"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function HostRestartSettings({
  suspended = false,
}: {
  suspended?: boolean;
}) {
  const state = useSyncExternalStore(
    hostRestartClient.subscribe,
    hostRestartClient.snapshot,
  );
  const [confirmation, setConfirmation] = useState<{
    scope: HostRestartScope;
    hostId: string;
    interruptWork: boolean;
  } | null>(null);
  useEffect(() => {
    let retired = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await hostRestartClient.refresh();
      if (!retired) timer = setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      retired = true;
      clearTimeout(timer);
    };
  }, []);
  const loading = !state.status && !state.error;
  const operation = state.status?.operation;
  const active = operation && operation.phase !== "rejected";
  const disabled =
    !state.status ||
    state.blocked ||
    state.sending ||
    !!state.pending ||
    !!active ||
    !!state.error;
  const hostDisabled = disabled || !state.status?.available;
  const allDisabled = disabled || !state.status?.allAvailable;
  const canStopAndRestart =
    !disabled &&
    operation?.phase === "rejected" &&
    (operation.busyReason === "active-work" ||
      operation.busyReason === "in-flight-operation");
  const unobserved =
    state.pending &&
    state.status?.hostId === state.pending.hostId &&
    operation?.id !== state.pending.operationId;
  const message =
    state.error ??
    (operation?.phase === "rejected" && operation.error
      ? `Last restart attempt: ${operation.error}`
      : operation?.error) ??
    (operation?.phase === "preparing"
      ? "Preparing restart…"
      : operation?.phase === "submitted"
        ? "Restart requested."
        : state.notice);
  return (
    <div id="settings-host-restart" className="host-restart">
      <SettingField
        label="Restart Host"
        description="Restart Inspire and its Pi sessions; keep terminals running."
      >
        {canStopAndRestart && !hostDisabled && operation?.scope === "host" ? (
          <button
            type="button"
            className="button button--danger"
            onClick={() =>
              setConfirmation({
                scope: "host",
                hostId: state.status!.hostId,
                interruptWork: true,
              })
            }
          >
            Stop work and restart Host
          </button>
        ) : (
          <button
            type="button"
            className="button button--danger-outline"
            aria-label="Restart Host"
            aria-busy={loading}
            disabled={hostDisabled}
            onClick={() =>
              setConfirmation({
                scope: "host",
                hostId: state.status!.hostId,
                interruptWork: false,
              })
            }
          >
            {loading ? (
              <PiLoader size={13} aria-hidden />
            ) : (
              <RefreshCw size={13} aria-hidden />
            )}
            Restart
          </button>
        )}
      </SettingField>
      <SettingField
        label="Restart all"
        description={
          state.status && !state.status.allAvailable
            ? state.status.allReason
            : "Restart Inspire and Pi, and close all project terminals."
        }
      >
        {canStopAndRestart && !allDisabled && operation?.scope === "all" ? (
          <button
            type="button"
            className="button button--danger"
            onClick={() =>
              setConfirmation({
                scope: "all",
                hostId: state.status!.hostId,
                interruptWork: true,
              })
            }
          >
            Stop work and restart all
          </button>
        ) : (
          <button
            type="button"
            className="button button--danger-outline"
            aria-label="Restart all"
            aria-busy={loading}
            disabled={allDisabled}
            onClick={() =>
              setConfirmation({
                scope: "all",
                hostId: state.status!.hostId,
                interruptWork: false,
              })
            }
          >
            {loading ? (
              <PiLoader size={13} aria-hidden />
            ) : (
              <RefreshCw size={13} aria-hidden />
            )}
            Restart all
          </button>
        )}
      </SettingField>
      {(state.status && !state.status.available) ||
      message ||
      unobserved ||
      state.error ||
      state.pending ||
      active ? (
        <div className="host-restart__status-row">
          <div className="host-restart__status-copy">
            {state.status && !state.status.available ? (
              <p className="settings__field-help">{state.status.reason}</p>
            ) : null}
            {message ? (
              <p
                className="host-restart__status"
                role={state.error || operation?.error ? "alert" : "status"}
              >
                {message}
              </p>
            ) : null}
            {unobserved ? (
              <p className="settings__field-help">
                Restart request not confirmed.
              </p>
            ) : null}
          </div>
          {state.error || state.pending || active ? (
            <div className="host-restart__status-actions">
              <button
                type="button"
                className="button button--quiet"
                onClick={() => void hostRestartClient.refresh()}
              >
                Recheck status
              </button>
              {state.blocked || state.pending ? (
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={state.sending}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Clear this browser's restart recovery record? This does not cancel a restart already sent. Check the Host status before starting another restart.",
                      )
                    )
                      void hostRestartClient.clearRecovery();
                  }}
                >
                  Clear local restart record…
                </button>
              ) : null}
              {unobserved ? (
                <button
                  type="button"
                  className="button"
                  disabled={state.sending || state.blocked || !!active}
                  onClick={() => void hostRestartClient.retry()}
                >
                  Retry same request
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {confirmation && !suspended ? (
        <RestartConfirmation
          scope={confirmation.scope}
          interruptWork={confirmation.interruptWork}
          onClose={() => setConfirmation(null)}
          onConfirm={() => {
            void hostRestartClient.start(
              confirmation.scope,
              confirmation.hostId,
              confirmation.interruptWork,
            );
            setConfirmation(null);
          }}
        />
      ) : null}
    </div>
  );
}
