import type { ReactNode } from "react";
import { PromptChoices, PromptInput } from "./PromptFields";

type ExtensionDialogQuestion = { title?: string } & (
  | {
      unsupported?: false;
      method: "select" | "confirm" | "input" | "editor";
      message?: string;
      options?: readonly string[];
      placeholder?: string;
      prefill?: string;
    }
  | { unsupported: true; details: ReactNode }
);

export interface ExtensionDialogContentProps {
  question: ExtensionDialogQuestion;
  value?: string;
  onValueChange?: (value: string) => void;
  pending: boolean;
  error?: string | null;
  onAnswer: (answer: string | boolean) => void;
  onCancel: () => void;
}

export function ExtensionDialogContent({
  question,
  value,
  onValueChange,
  pending,
  error,
  onAnswer,
  onCancel,
}: ExtensionDialogContentProps) {
  const title =
    question.title ||
    (question.unsupported
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
    !question.unsupported &&
    (question.method === "input" || question.method === "editor")
  ) {
    const editor = question.method === "editor";
    return (
      <PromptInput
        title={title}
        kind={editor ? "editor" : "text"}
        initialValue={editor ? question.prefill : undefined}
        value={value}
        onValueChange={onValueChange}
        placeholder={question.placeholder}
        pending={pending}
        error={reportError}
        submitLabel={editor ? "Save" : "Submit"}
        onSubmit={onAnswer}
      >
        {cancel}
      </PromptInput>
    );
  }

  return (
    <>
      <h2 className="dialog__title">{title}</h2>
      {question.unsupported ? (
        <>
          <p className="dialog__message">
            Inspire can't handle this extension request.
          </p>
          {question.details}
        </>
      ) : question.method === "select" ? (
        <PromptChoices
          label={title}
          options={(question.options ?? []).map((option) => ({
            value: option,
            label: option,
          }))}
          pending={pending}
          optionClassName="extension-dialog__choice"
          onChoose={onAnswer}
        />
      ) : question.message ? (
        <p className="dialog__message">{question.message}</p>
      ) : null}
      {reportError}
      <div className="dialog__actions">
        {question.unsupported ? (
          <button
            type="button"
            className="button button--primary"
            data-modal-autofocus
            disabled={pending}
            onClick={onCancel}
          >
            Cancel request
          </button>
        ) : question.method === "confirm" ? (
          [false, true].map((confirmed) => (
            <button
              key={String(confirmed)}
              type="button"
              className={confirmed ? "button button--primary" : "button"}
              data-modal-autofocus={confirmed || undefined}
              disabled={pending}
              onClick={() => onAnswer(confirmed)}
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
