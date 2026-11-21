import { RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { canStartHostRestart } from "../../shared/host-restart";
import { hostRestartClient } from "../controllers/host-restart-controller";
import { ConfirmationDialog } from "./Modal";
import { SettingField } from "./SettingsControls";

export function HostRestartSettings({
  visible,
  suspended = false,
}: {
  visible: boolean;
  suspended?: boolean;
}) {
  const state = useSyncExternalStore(
    hostRestartClient.subscribe,
    hostRestartClient.snapshot,
  );
  const [confirmHostId, setConfirmHostId] = useState<string | null>(null);
  const observing = visible || Boolean(state.pending);
  useEffect(() => {
    let retired = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await hostRestartClient.refresh(!observing);
      if (observing && !retired) timer = setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      retired = true;
      clearTimeout(timer);
    };
  }, [observing]);
  const operation = state.status?.operation;
  const disabled =
    !state.status || state.sending || !canStartHostRestart(operation);
  const busy =
    operation?.phase === "rejected" &&
    (operation.busyReason === "active-work" ||
      operation.busyReason === "in-flight-operation");
  const unconfirmed =
    operation?.phase === "rejected" && operation.stopUnconfirmed === true;
  const retry = Boolean(state.pending);
  const requestRestart = () => {
    if (!state.status) return;
    const hostId = state.status.hostId;
    if (retry) void hostRestartClient.retry();
    else if (unconfirmed)
      void hostRestartClient.start("host", hostId, true, true);
    else if (busy) void hostRestartClient.start("host", hostId, true);
    else setConfirmHostId(hostId);
  };
  const currentOperation =
    !state.pending || operation?.id === state.pending.operationId
      ? operation
      : null;
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
        ? "Pi is busy."
        : currentOperation.busyReason === "in-flight-operation"
          ? "A request is still in progress."
          : currentOperation.error
      : currentOperation?.error);
  const message =
    progress ??
    failure ??
    (state.pending && !currentOperation
      ? "Restart did not finish. Try again."
      : state.notice);
  const unavailable =
    state.status?.available === false ? state.status.reason : null;
  const action = retry
    ? "Try again"
    : unconfirmed
      ? "Restart anyway"
      : busy
        ? "Stop work and restart"
        : "Restart";
  return (
    <>
      <SettingField
        id="settings-host-restart"
        label="Restart"
        description={
          unavailable ??
          "Restart Inspire, its Pi workers, and project terminals."
        }
        feedback={
          message ? (
            <span
              className={message === failure ? "settings__error" : undefined}
              role={message === failure ? "alert" : "status"}
            >
              {message}
            </span>
          ) : undefined
        }
      >
        <button
          type="button"
          className="button button--danger-outline"
          disabled={disabled || !state.status?.available}
          onClick={requestRestart}
        >
          {action === "Restart" ? <RefreshCw size={13} aria-hidden /> : null}
          {action}
        </button>
      </SettingField>
      {confirmHostId && !suspended ? (
        <ConfirmationDialog
          id="host-restart"
          title="Restart?"
          description="Inspire's Pi workers and project terminals will restart. The page will briefly disconnect."
          onClose={() => setConfirmHostId(null)}
          confirm={{
            label: "Restart",
            run: () => {
              void hostRestartClient.start("host", confirmHostId, false);
              setConfirmHostId(null);
            },
          }}
        />
      ) : null}
    </>
  );
}
