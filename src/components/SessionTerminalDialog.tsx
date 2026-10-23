import { useState } from "react";
import { isBusyRunState } from "../../shared/contracts";
import { shallowEqual, store, useAppState } from "../store";
import { useCopied } from "../use-copied";
import { useModalFocus } from "../use-modal-focus";
import { ButtonLabel } from "./ButtonLabel";
import { CopyFeedback } from "./CopyFeedback";

export function SessionTerminalDialog({
  sessionId,
  onClose,
  active = true,
}: {
  sessionId: string;
  onClose: () => void;
  active?: boolean;
}) {
  const state = useAppState(
    (s) => ({
      busy:
        isBusyRunState(s.runState) || s.bashRunning || s.queue.totalCount > 0,
      terminal: s.readOnlyReason === "terminal",
    }),
    shallowEqual,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const ref = useModalFocus<HTMLDivElement>(active, sessionId, () => {
    if (!pending) onClose();
  });
  const { copied, copying, copy } = useCopied({
    scope: sessionId,
    onError: store.reportCopyError,
  });
  const release = async () => {
    setPending(true);
    setError(null);
    try {
      if (store.getState().sessionId !== sessionId)
        throw new Error("The selected session changed");
      if (state.busy) await store.abort();
      setCommand(
        await store.setSessionExecution(sessionId, "terminal", state.busy),
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not release this session",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="overlay" role="presentation">
      <div
        ref={ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Use in terminal"
        tabIndex={-1}
      >
        <h2 className="dialog__title">Use in terminal</h2>
        {command ? (
          <>
            <p className="dialog__message">
              Inspire released this session. Run this command in your terminal;
              other Inspire sessions keep running.
            </p>
            <pre className="card__mono">{command}</pre>
          </>
        ) : (
          <p className="dialog__message">
            {state.busy
              ? "Stop this session and restore Pending input to your draft. "
              : ""}
            Other sessions keep running. History and your draft stay here.
            Inspire will not restart this Pi until you choose Continue in
            Inspire.
          </p>
        )}
        {error ? (
          <p className="dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog__actions">
          <button
            type="button"
            className="button button--quiet"
            disabled={pending}
            onClick={onClose}
          >
            {command ? "Close" : "Cancel"}
          </button>
          {command ? (
            <button
              type="button"
              className="button button--primary"
              onClick={() => void copy(command)}
            >
              <CopyFeedback copied={copied} copying={copying} />
              <ButtonLabel reserve="Copy command">
                {copied ? "Copied" : "Copy command"}
              </ButtonLabel>
            </button>
          ) : (
            <button
              type="button"
              className="button button--primary"
              disabled={pending}
              onClick={() => void release()}
            >
              {pending
                ? "Releasing…"
                : state.terminal
                  ? "Show terminal command"
                  : state.busy
                    ? "Stop and use in terminal"
                    : "Use in terminal"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function TerminalSessionNotice({ sessionId }: { sessionId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = async () => {
    setPending(true);
    setError(null);
    try {
      await store.setSessionExecution(sessionId, "inspire");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not check this session",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div role="status">
      <p>Handed to the terminal. History and your draft are kept here.</p>
      <button
        type="button"
        className="button button--quiet"
        disabled={pending}
        onClick={() => void resume()}
      >
        {pending ? "Checking Pi…" : "Continue in Inspire"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
