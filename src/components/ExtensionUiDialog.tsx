import { useEffect, useState } from "react";
import { store, useAppState, type ExtensionUiRequest } from "../store";
import { useModalFocus } from "../use-modal-focus";

function cancel(request: ExtensionUiRequest): void {
  void store.respondExtensionUi({ id: request.id, cancelled: true });
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !responding) cancel(request);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, responding]);

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
          <code>{request.method}</code>. It cannot be completed in insπre.
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
        <div className="dialog__options" role="listbox" aria-label={title}>
          {(request.options ?? []).map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={false}
              key={option}
              className="picker__row"
              disabled={responding}
              onClick={() =>
                void store.respondExtensionUi({ id: request.id, value: option })
              }
            >
              {option}
            </button>
          ))}
        </div>
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
            onClick={() => cancel(request)}
          >
            Cancel
          </button>
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
export function ExtensionUiDialog() {
  const state = useAppState();
  const request = state.extensionUiRequests[0] ?? null;
  const responding = Boolean(state.extensionUiRespondingId);
  const dialogRef = useModalFocus<HTMLDivElement>(
    Boolean(request),
    request ? `${request.sessionId}:${request.id}` : null,
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
      </div>
    </div>
  );
}
