import { useLayoutEffect, useRef, useState } from "react";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { store } from "../store";

export function RenameSessionForm({
  sessionId,
  initialName,
  active = true,
  onClose,
  onSaved,
}: {
  sessionId: string;
  initialName: string;
  active?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const editRevision = useRef(0);
  const [value, setValue] = useState(initialName);
  const [saving, setSaving] = useState(false);

  useLayoutEffect(() => {
    if (active) {
      input.current?.focus();
      input.current?.select();
    }
  }, [active]);

  const submit = async () => {
    const name = value.trim();
    if (!active || saving || !name || store.getState().sessionId !== sessionId)
      return;
    if (
      name === initialName.trim() ||
      name === store.getState().sessionName.trim()
    ) {
      onSaved();
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
        onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-busy={saving || undefined}
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
      <input
        className="palette__input"
        ref={input}
        data-modal-autofocus
        aria-label="New session name"
        value={value}
        onChange={(event) => {
          editRevision.current += 1;
          setValue(event.target.value);
        }}
      />
      <footer className="dialog__actions palette__prepare-actions">
        <button
          type="button"
          className="button button--quiet"
          onClick={onClose}
        >
          Back
        </button>
        <button
          type="submit"
          className="button button--primary"
          disabled={saving || !value.trim()}
        >
          Rename
        </button>
      </footer>
    </form>
  );
}
