import { useId, useLayoutEffect, useRef, useState } from "react";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { store } from "../store";
import { Modal } from "./Modal";

export function RenameSessionDialog({
  sessionId,
  initialName,
  active = true,
  onClose,
}: {
  sessionId: string;
  initialName: string;
  active?: boolean;
  onClose: () => void;
}) {
  const title = useId();
  const input = useRef<HTMLInputElement>(null);
  const editRevision = useRef(0);
  const [value, setValue] = useState(initialName);
  const [saving, setSaving] = useState(false);

  useLayoutEffect(() => {
    input.current?.select();
  }, []);

  const submit = async () => {
    const name = value.trim();
    if (!active || saving || !name || store.getState().sessionId !== sessionId)
      return;
    if (
      name === initialName.trim() ||
      name === store.getState().sessionName.trim()
    ) {
      onClose();
      return;
    }
    const revision = editRevision.current;
    setSaving(true);
    try {
      const saved = await store.renameSession(sessionId, name);
      if (
        saved &&
        revision === editRevision.current &&
        input.current &&
        store.getState().sessionId === sessionId
      )
        onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      active={active}
      owner={sessionId}
      aria-labelledby={title}
      aria-busy={saving || undefined}
      onDismiss={onClose}
    >
      <form
        className="dialog"
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            isComposingKeyboardEvent(event.nativeEvent)
          )
            event.preventDefault();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="dialog__title" id={title}>
          Rename session
        </h2>
        <input
          className="text-field"
          ref={input}
          data-modal-autofocus
          aria-label="Session name"
          value={value}
          onChange={(event) => {
            editRevision.current += 1;
            setValue(event.target.value);
          }}
        />
        <footer className="dialog__actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={saving || !value.trim()}
          >
            Save session name
          </button>
        </footer>
      </form>
    </Modal>
  );
}
