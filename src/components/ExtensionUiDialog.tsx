import { useEffect, useState } from "react";
import { store, useAppState, type ExtensionUiRequest } from "../store";

function cancel(request: ExtensionUiRequest): void {
  void store.respondExtensionUi({ id: request.id, cancelled: true });
}

function DialogBody({ request }: { request: ExtensionUiRequest }) {
  const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel(request);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request]);

  const title = request.title || "Pi extension request";

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
              onClick={() => void store.respondExtensionUi({ id: request.id, value: option })}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="dialog__actions">
          <button type="button" className="button" onClick={() => cancel(request)}>
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
        {request.message ? <p className="dialog__message">{request.message}</p> : null}
        <div className="dialog__actions">
          <button type="button" className="button" onClick={() => cancel(request)}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void store.respondExtensionUi({ id: request.id, confirmed: false })}
          >
            No
          </button>
          <button
            type="button"
            className="button button--primary"
            autoFocus
            onClick={() => void store.respondExtensionUi({ id: request.id, confirmed: true })}
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
        void store.respondExtensionUi({ id: request.id, value });
      }}
    >
      <h2 className="dialog__title">{title}</h2>
      {isEditor ? (
        <textarea
          className="dialog__editor"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label={title}
          autoFocus
          rows={10}
        />
      ) : (
        <input
          className="dialog__input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={request.placeholder}
          aria-label={title}
          autoFocus
        />
      )}
      <div className="dialog__actions">
        <button type="button" className="button" onClick={() => cancel(request)}>
          Cancel
        </button>
        <button type="submit" className="button button--primary">
          {isEditor ? "Save" : "Submit"}
        </button>
      </div>
    </form>
  );
}

/** Web-native presentation of Pi extension_ui_request dialogs. */
export function ExtensionUiDialog() {
  const state = useAppState();
  const request = state.extensionUi;
  if (!request) return null;
  return (
    <div className="overlay" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={request.title || "Pi extension request"}>
        {/* key remounts the form state per request */}
        <DialogBody key={request.id} request={request} />
      </div>
    </div>
  );
}
