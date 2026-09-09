import { RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { HostRestartScope } from "../../shared/host-restart";
import { hostRestartClient } from "../controllers/host-restart-controller";
import { useModalFocus } from "../use-modal-focus";

function RestartConfirmation({
  scope,
  onClose,
  onConfirm,
}: {
  scope: HostRestartScope;
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
          {scope === "all" ? "Restart all?" : "Restart Host?"}
        </h2>
        <p className="dialog__message" id="host-restart-description">
          {scope === "all"
            ? "This will end all project terminal processes and briefly disconnect the page."
            : "The page will briefly disconnect."}
        </p>
        <div className="host-restart__actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${scope === "all" ? "button--danger" : "button--primary"}`}
            onClick={onConfirm}
          >
            {scope === "all" ? "Restart all" : "Restart Host"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function HostRestartSettings() {
  const state = useSyncExternalStore(
    hostRestartClient.subscribe,
    hostRestartClient.snapshot,
  );
  const [confirmation, setConfirmation] = useState<{
    scope: HostRestartScope;
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
    !state.status?.available ||
    state.blocked ||
    state.sending ||
    !!state.pending ||
    !!active ||
    !!state.error;
  const unobserved =
    state.pending &&
    state.status?.hostId === state.pending.hostId &&
    operation?.id !== state.pending.operationId;
  const message =
    state.error ??
    operation?.error ??
    (operation?.phase === "preparing"
      ? "Preparing restart…"
      : operation?.phase === "submitted"
        ? "Restart requested."
        : state.notice);
  return (
    <div className="settings__update-entry host-restart">
      <div className="settings__update-entry-header">
        <span className="settings__field-label">Restart</span>
      </div>
      <div className="host-restart__actions">
        {(["host", "all"] as const).map((scope) => (
          <button
            key={scope}
            type="button"
            className="button"
            disabled={disabled}
            onClick={() =>
              setConfirmation({ scope, hostId: state.status!.hostId })
            }
          >
            <RefreshCw size={14} aria-hidden />
            {scope === "all" ? "Restart all" : "Restart Host"}
          </button>
        ))}
      </div>
      {!state.status ? (
        <p className="settings__field-help">Checking availability…</p>
      ) : !state.status.available ? (
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
        <p className="settings__field-help">Restart request not confirmed.</p>
      ) : null}
      {state.error || state.pending || active ? (
        <div className="host-restart__actions">
          <button
            type="button"
            className="button"
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
      {confirmation ? (
        <RestartConfirmation
          scope={confirmation.scope}
          onClose={() => setConfirmation(null)}
          onConfirm={() => {
            void hostRestartClient.start(
              confirmation.scope,
              confirmation.hostId,
            );
            setConfirmation(null);
          }}
        />
      ) : null}
    </div>
  );
}
