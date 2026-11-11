import { RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { HostRestartScope } from "../../shared/host-restart";
import { hostRestartClient } from "../controllers/host-restart-controller";
import { useModalFocus } from "../use-modal-focus";
import { SettingField } from "./SettingsControls";

type SettingsRestartScope = Exclude<HostRestartScope, "host-only">;

const RESTART_NAMES: Record<SettingsRestartScope, string> = {
  host: "Restart Host",
  all: "Restart all",
};

function RestartConfirmation({
  scope,
  onClose,
  onConfirm,
}: {
  scope: SettingsRestartScope;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useModalFocus<HTMLDivElement>(true, "host-restart", onClose);
  const name = RESTART_NAMES[scope];
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
          {name}?
        </h2>
        <p className="dialog__message" id="host-restart-description">
          {scope === "all"
            ? "This Host's project terminals will close."
            : "Inspire's Pi workers will restart. Project terminals keep running."}{" "}
          The page will briefly disconnect.
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
            {name}
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
    scope: SettingsRestartScope;
    hostId: string;
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
  const busyScope =
    operation?.phase === "rejected" &&
    (operation.busyReason === "active-work" ||
      operation.busyReason === "in-flight-operation")
      ? operation.scope
      : null;
  const unconfirmedScope =
    operation?.phase === "rejected" && operation.stopUnconfirmed
      ? operation.scope
      : null;
  const requestRestart = (scope: SettingsRestartScope) => {
    if (!state.status) return;
    const hostId = state.status.hostId;
    if (scope === unconfirmedScope)
      void hostRestartClient.start(scope, hostId, true, true);
    else if (scope === busyScope)
      void hostRestartClient.start(scope, hostId, true);
    else setConfirmation({ scope, hostId });
  };
  const currentOperation =
    !state.pending || operation?.id === state.pending.operationId
      ? operation
      : null;
  const unobserved =
    !state.sending &&
    state.pending &&
    state.status?.hostId === state.pending.hostId &&
    !currentOperation;
  const progress =
    currentOperation?.phase === "submitted"
      ? "Restart requested."
      : state.sending || currentOperation?.phase === "preparing"
        ? "Preparing restart…"
        : null;
  const failure =
    state.error ??
    (currentOperation?.phase === "rejected"
      ? currentOperation.busyReason === "active-work"
        ? "Last restart attempt: Pi was busy."
        : currentOperation.busyReason === "in-flight-operation"
          ? "Last restart attempt: a request was still in progress."
          : currentOperation.error &&
            `Last restart attempt: ${currentOperation.error}`
      : currentOperation?.error);
  const message =
    state.blocked && state.error
      ? state.error
      : (progress ??
        failure ??
        (unobserved ? "Restart request not confirmed." : state.notice));
  const unavailable =
    state.status?.available === false ? state.status.reason : null;
  return (
    <div id="settings-host-restart" className="host-restart">
      <SettingField
        label="Restart Host"
        description="Restart Inspire and its Pi workers. Project terminals keep running."
      >
        <button
          type="button"
          className="button button--danger-outline"
          aria-label={
            unconfirmedScope === "host"
              ? "Restart Host anyway"
              : busyScope === "host"
                ? "Stop work and restart Host"
                : "Restart Host"
          }
          disabled={hostDisabled}
          onClick={() => requestRestart("host")}
        >
          {unconfirmedScope === "host" ? (
            "Restart anyway"
          ) : busyScope === "host" ? (
            "Stop work and restart"
          ) : (
            <>
              <RefreshCw size={13} aria-hidden />
              Restart
            </>
          )}
        </button>
      </SettingField>
      <SettingField
        label="Restart all"
        description={
          state.status && !state.status.allAvailable
            ? state.status.allReason
            : "Also close this Host's project terminals."
        }
      >
        <button
          type="button"
          className="button button--danger-outline"
          aria-label={
            unconfirmedScope === "all"
              ? "Restart all anyway"
              : busyScope === "all"
                ? "Stop work and restart all"
                : "Restart all"
          }
          disabled={allDisabled}
          onClick={() => requestRestart("all")}
        >
          {unconfirmedScope === "all" ? (
            "Restart all anyway"
          ) : busyScope === "all" ? (
            "Stop work and restart all"
          ) : (
            <>
              <RefreshCw size={13} aria-hidden />
              Restart all
            </>
          )}
        </button>
      </SettingField>
      <div className="host-restart__status-row">
        <div className="host-restart__status-copy">
          {unavailable ? (
            <p className="settings__field-help">{unavailable}</p>
          ) : null}
          {message ? (
            <p
              className="host-restart__status"
              role={message === failure ? "alert" : "status"}
            >
              {message}
            </p>
          ) : null}
          {state.error && state.recoveryInvalid ? (
            <button
              type="button"
              className="button button--quiet"
              disabled={state.sending}
              onClick={() => {
                if (
                  window.confirm(
                    "Clear this browser's restart record? Any restart already requested can still run. Recheck Host status before another restart.",
                  )
                )
                  void hostRestartClient.clearRecovery();
              }}
            >
              Reset restart recovery…
            </button>
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
      {confirmation && !suspended ? (
        <RestartConfirmation
          scope={confirmation.scope}
          onClose={() => setConfirmation(null)}
          onConfirm={() => {
            void hostRestartClient.start(
              confirmation.scope,
              confirmation.hostId,
              false,
            );
            setConfirmation(null);
          }}
        />
      ) : null}
    </div>
  );
}
