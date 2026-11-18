import { RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { hostRestartClient } from "../controllers/host-restart-controller";
import { ConfirmationDialog } from "./Modal";
import { SettingField } from "./SettingsControls";

type SettingsRestartScope = "host" | "all-pi";

const RESTART_NAMES: Record<SettingsRestartScope, string> = {
  host: "Restart",
  "all-pi": "Restart all",
};

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
  const disabled = !state.status || state.blocked || state.sending || !!active;
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
    if (state.pending?.scope === scope) void hostRestartClient.retry();
    else if (scope === unconfirmedScope)
      void hostRestartClient.start(scope, hostId, true, true);
    else if (scope === busyScope)
      void hostRestartClient.start(scope, hostId, true);
    else setConfirmation({ scope, hostId });
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
        (state.pending && !currentOperation
          ? "Couldn’t confirm the restart."
          : state.notice));
  const unavailable =
    state.status?.available === false ? state.status.reason : null;
  return (
    <div id="settings-host-restart" className="host-restart">
      {(["host", "all-pi"] as const).map((scope) => {
        const host = scope === "host";
        const name = RESTART_NAMES[scope];
        const retry = state.pending?.scope === scope;
        const action = retry
          ? "Try again"
          : unconfirmedScope === scope
            ? `${name} anyway`
            : busyScope === scope
              ? `Stop work and ${name.toLowerCase()}`
              : name;
        const available = host
          ? state.status?.available
          : state.status?.allPiAvailable;
        return (
          <SettingField
            key={scope}
            label={name}
            description={
              host
                ? "Restart Inspire and its Pi workers. Keep project terminals running."
                : state.status && !available
                  ? state.status.allPiReason
                  : state.status?.allPiIncludesHerdr
                    ? "Close all Pi sessions and restart Inspire."
                    : "Close Pi sessions outside Herdr and restart Inspire."
            }
          >
            <button
              type="button"
              className="button button--danger-outline"
              disabled={disabled || !available || (!!state.pending && !retry)}
              onClick={() => requestRestart(scope)}
            >
              {action === name ? <RefreshCw size={13} aria-hidden /> : null}
              {action}
            </button>
          </SettingField>
        );
      })}
      {unavailable || message ? (
        <div className="host-restart__status-row">
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
        </div>
      ) : null}
      {confirmation && !suspended ? (
        <ConfirmationDialog
          id="host-restart"
          title={`${RESTART_NAMES[confirmation.scope]}?`}
          description={
            confirmation.scope === "all-pi"
              ? state.status?.allPiIncludesHerdr
                ? "All your Pi sessions, including Herdr sessions, will close. Project terminals will close and running tasks will stop."
                : "Your Pi sessions outside Herdr will close. Project terminals will close and running tasks will stop."
              : "Inspire's Pi workers will restart. Project terminals keep running. The page will briefly disconnect."
          }
          onClose={() => setConfirmation(null)}
          confirm={{
            label: RESTART_NAMES[confirmation.scope],
            run: () => {
              void hostRestartClient.start(
                confirmation.scope,
                confirmation.hostId,
                confirmation.scope === "all-pi",
              );
              setConfirmation(null);
            },
          }}
        />
      ) : null}
    </div>
  );
}
