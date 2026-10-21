import { useRef, useState } from "react";
import type {
  ExtensionUiRequest,
  SupportedExtensionUiRequest,
} from "../../shared/contracts";
import { isComposingKeyboardEvent } from "../keyboard-input";
type Respond = (payload: Record<string, unknown>) => void;

export interface ExtensionDialogContentProps {
  request: ExtensionUiRequest;
  value: string;
  pending: boolean;
  error?: string | null;
  onValueChange: (value: string) => void;
  onRespond: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
}

/** Presentation only: no store, session selection, transport or modal ownership. */
export function ExtensionDialogContent(props: ExtensionDialogContentProps) {
  return <RequestFields {...props} />;
}

function RequestError({ error }: { error?: string | null }) {
  return error ? (
    <p className="dialog__error" role="alert" tabIndex={0}>
      {error}
    </p>
  ) : null;
}

function Selection({
  request,
  title,
  responding,
  onRespond,
}: {
  request: SupportedExtensionUiRequest;
  title: string;
  responding: boolean;
  onRespond: Respond;
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
          isComposingKeyboardEvent(event.nativeEvent) ||
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
          onRespond({
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
          onClick={() => onRespond({ id: request.id, value: option })}
        >
          <span className="extension-dialog__choice">{option}</span>
        </button>
      ))}
    </div>
  );
}

function RequestFields({
  request,
  value,
  pending: responding,
  error,
  onValueChange,
  onRespond,
  onCancel: cancel,
}: ExtensionDialogContentProps) {
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
        <RequestError error={error} />
        <div className="dialog__actions">
          <button
            type="button"
            className="button button--primary"
            autoFocus
            disabled={responding}
            onClick={cancel}
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
        <Selection
          request={request}
          title={title}
          responding={responding}
          onRespond={onRespond}
        />
        <RequestError error={error} />
        <div className="dialog__actions">
          <button
            type="button"
            className="button button--quiet"
            disabled={responding}
            onClick={cancel}
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
        <RequestError error={error} />
        <div className="dialog__actions">
          <button
            type="button"
            className="button"
            disabled={responding}
            onClick={() =>
              onRespond({
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
            onClick={() => onRespond({ id: request.id, confirmed: true })}
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
        if (!responding) onRespond({ id: request.id, value });
      }}
    >
      <h2 className="dialog__title">{title}</h2>
      {isEditor ? (
        <textarea
          className="dialog__editor"
          value={value}
          disabled={responding}
          onChange={(event) => onValueChange(event.target.value)}
          aria-label={title}
          autoFocus
          rows={10}
        />
      ) : (
        <input
          className="dialog__input"
          value={value}
          disabled={responding}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={request.placeholder}
          aria-label={title}
          autoFocus
        />
      )}
      <RequestError error={error} />
      <div className="dialog__actions">
        <button
          type="button"
          className="button button--quiet"
          disabled={responding}
          onClick={cancel}
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
