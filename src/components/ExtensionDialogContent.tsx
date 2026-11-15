import type { ExtensionUiRequest } from "../../shared/contracts";
import { PromptChoices, PromptInput } from "./PromptFields";
import {
  ActivityDetails,
  ActivityText,
} from "./transcript-activity-visibility";

export function ExtensionDialogContent({
  request,
  pending,
  error,
  onRespond,
  onCancel,
}: {
  request: ExtensionUiRequest;
  pending: boolean;
  error?: string | null;
  onRespond: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const title =
    request.title ||
    (request.unsupported
      ? "Unsupported extension request"
      : "Pi extension request");
  const reportError = error && (
    <p className="dialog__error" role="alert" tabIndex={0}>
      {error}
    </p>
  );
  const cancel = (
    <button
      type="button"
      className="button button--quiet"
      disabled={pending}
      onClick={onCancel}
    >
      Cancel
    </button>
  );

  if (
    !request.unsupported &&
    (request.method === "input" || request.method === "editor")
  ) {
    const editor = request.method === "editor";
    return (
      <PromptInput
        title={title}
        kind={editor ? "editor" : "text"}
        initialValue={editor ? request.prefill : undefined}
        placeholder={request.placeholder}
        pending={pending}
        error={reportError}
        submitLabel={editor ? "Save" : "Submit"}
        onSubmit={(value) => onRespond({ id: request.id, value })}
      >
        {cancel}
      </PromptInput>
    );
  }

  return (
    <>
      <h2 className="dialog__title">{title}</h2>
      {request.unsupported ? (
        <>
          <p className="dialog__message">
            Inspire can't handle this extension request.
          </p>
          <ActivityDetails
            reader="extension-request"
            label="Request details"
            className="dialog__details"
            key={request.id}
          >
            {() => (
              <>
                <code>{request.method}</code>
                <ActivityText
                  label="Request payload"
                  text={JSON.stringify(request.payload, null, 2)}
                />
              </>
            )}
          </ActivityDetails>
        </>
      ) : request.method === "select" ? (
        <PromptChoices
          label={title}
          options={(request.options ?? []).map((option) => ({
            value: option,
            label: option,
          }))}
          pending={pending}
          optionClassName="extension-dialog__choice"
          onChoose={(value) => onRespond({ id: request.id, value })}
        />
      ) : request.message ? (
        <p className="dialog__message">{request.message}</p>
      ) : null}
      {reportError}
      <div className="dialog__actions">
        {request.unsupported ? (
          <button
            type="button"
            className="button button--primary"
            data-modal-autofocus
            disabled={pending}
            onClick={onCancel}
          >
            Cancel request
          </button>
        ) : request.method === "confirm" ? (
          [false, true].map((confirmed) => (
            <button
              key={String(confirmed)}
              type="button"
              className={confirmed ? "button button--primary" : "button"}
              data-modal-autofocus={confirmed || undefined}
              disabled={pending}
              onClick={() => onRespond({ id: request.id, confirmed })}
            >
              {confirmed ? "Yes" : "No"}
            </button>
          ))
        ) : (
          cancel
        )}
      </div>
    </>
  );
}
