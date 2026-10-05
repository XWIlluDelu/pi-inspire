import { memo, useEffect, useRef, useState } from "react";
import type {
  ExtensionUiRequest,
  SupportedExtensionUiRequest,
} from "../../shared/contracts";
import { shallowEqual, store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";

function cancel(request: ExtensionUiRequest): void {
  void store.respondExtensionUi({ id: request.id, cancelled: true });
}

function RequestTime({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  const time =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <p className="dialog__remaining">{time} remaining</p>;
}

function Selection({
  request,
  title,
  responding,
}: {
  request: SupportedExtensionUiRequest;
  title: string;
  responding: boolean;
}) {
  const [selected, setSelected] = useState(0);
  const optionsRef = useRef<HTMLDivElement>(null);
  const options = request.options ?? [];
  return (
    <div
      ref={optionsRef}
      className="dialog__options"
      role="listbox"
      aria-label={title}
      onKeyDown={(event) => {
        if (
          responding ||
          options.length === 0 ||
          event.nativeEvent.isComposing ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next =
            (selected + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
            options.length;
          optionsRef.current
            ?.querySelectorAll<HTMLButtonElement>("[role=option]")
            [next]?.focus();
        } else if (event.key === "Enter") {
          event.preventDefault();
          void store.respondExtensionUi({
            id: request.id,
            value: options[selected],
          });
        }
      }}
    >
      {options.map((option, index) => (
        <button
          type="button"
          role="option"
          aria-selected={selected === index}
          tabIndex={selected === index ? 0 : -1}
          key={index}
          className="picker__row"
          disabled={responding}
          onFocus={() => setSelected(index)}
          onClick={() =>
            void store.respondExtensionUi({ id: request.id, value: option })
          }
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function DialogBody({
  request,
  responding,
}: {
  request: ExtensionUiRequest;
  responding: boolean;
}) {
  const [value, setValue] = useState(
    request.method === "editor" && "prefill" in request
      ? (request.prefill ?? "")
      : "",
  );

  const title =
    request.title ||
    (request.unsupported
      ? "Unsupported extension request"
      : "Pi extension request");

  if (request.unsupported) {
    return (
      <>
        <h2 className="dialog__title">{title}</h2>
        <p className="dialog__message">
          This extension requested the unsupported interactive method{" "}
          <code>{request.method}</code>. It cannot be completed in Inspire.
        </p>
        <details className="dialog__details">
          <summary>Inspect request</summary>
          <pre className="card__mono">
            {JSON.stringify(request.payload, null, 2)}
          </pre>
        </details>
        <div className="dialog__actions">
          <button
            type="button"
            className="button button--primary"
            autoFocus
            disabled={responding}
            onClick={() => cancel(request)}
          >
            Close and cancel request
          </button>
        </div>
      </>
    );
  }

  if (request.method === "select") {
    return (
      <>
        <h2 className="dialog__title">{title}</h2>
        <Selection request={request} title={title} responding={responding} />
        <div className="dialog__actions">
          <button
            type="button"
            className="button"
            disabled={responding}
            onClick={() => cancel(request)}
          >
            Cancel
          </button>
        </div>
      </>
    );
  }

  if (request.method === "confirm") {
    return (
      <>
        <h2 className="dialog__title">{title}</h2>
        {request.message ? (
          <p className="dialog__message">{request.message}</p>
        ) : null}
        <div className="dialog__actions">
          <button
            type="button"
            className="button"
            disabled={responding}
            onClick={() =>
              void store.respondExtensionUi({
                id: request.id,
                confirmed: false,
              })
            }
          >
            No
          </button>
          <button
            type="button"
            className="button button--primary"
            autoFocus
            data-modal-autofocus
            disabled={responding}
            onClick={() =>
              void store.respondExtensionUi({ id: request.id, confirmed: true })
            }
          >
            Yes
          </button>
        </div>
      </>
    );
  }

  const isEditor = request.method === "editor";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!responding)
          void store.respondExtensionUi({ id: request.id, value });
      }}
    >
      <h2 className="dialog__title">{title}</h2>
      {isEditor ? (
        <textarea
          className="dialog__editor"
          value={value}
          disabled={responding}
          onChange={(event) => setValue(event.target.value)}
          aria-label={title}
          autoFocus
          rows={10}
        />
      ) : (
        <input
          className="dialog__input"
          value={value}
          disabled={responding}
          onChange={(event) => setValue(event.target.value)}
          placeholder={request.placeholder}
          aria-label={title}
          autoFocus
        />
      )}
      <div className="dialog__actions">
        <button
          type="button"
          className="button"
          disabled={responding}
          onClick={() => cancel(request)}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="button button--primary"
          disabled={responding}
        >
          {isEditor ? "Save" : "Submit"}
        </button>
      </div>
    </form>
  );
}

/** Web-native presentation of Pi extension_ui_request dialogs. */
export const ExtensionUiDialog = memo(function ExtensionUiDialog() {
  const { requests, respondingId, runState } = useAppState(
    (state) => ({
      requests: state.extensionUiRequests,
      respondingId: state.extensionUiRespondingId,
      runState: state.runState,
    }),
    shallowEqual,
  );
  const request = requests[0] ?? null;
  const responding = Boolean(respondingId);
  const dialogRef = useModalFocus<HTMLDivElement>(
    Boolean(request),
    request ? `${request.sessionId}:${request.id}` : null,
    request
      ? () => {
          // Conflict recovery is a host-owned Escape path and must remain
          // available even when this extension request is still visible.
          if (runState === "conflict") return false;
          if (!responding) cancel(request);
        }
      : undefined,
  );
  if (!request) return null;
  return (
    <div className="overlay" role="presentation">
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={request.title || "Pi extension request"}
        aria-busy={responding}
        tabIndex={-1}
      >
        {/* key remounts the form state per request */}
        <DialogBody
          key={`${request.sessionId}:${request.id}`}
          request={request}
          responding={responding}
        />
        {request.expiresAt !== undefined ? (
          <RequestTime
            key={`${request.sessionId}:${request.id}:${request.expiresAt}`}
            expiresAt={request.expiresAt}
          />
        ) : null}
      </div>
    </div>
  );
});
