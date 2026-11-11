import { Paperclip } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { clipboardFiles } from "../clipboard-files";

export function useComposerAttachmentInput(
  addFiles: (files: File[]) => void | Promise<void>,
  disabled: boolean,
  sessionId?: string | null,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => setDragging(false), [sessionId]);

  return {
    dragging,
    dropHandlers: {
      onDragOver(event: DragEvent<HTMLFormElement>) {
        event.preventDefault();
        setDragging(true);
      },
      onDragLeave() {
        setDragging(false);
      },
      onDrop(event: DragEvent<HTMLFormElement>) {
        event.preventDefault();
        setDragging(false);
        if (!disabled) void addFiles(Array.from(event.dataTransfer.files));
      },
    },
    onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
      const files = clipboardFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void addFiles(files);
    },
    input: (
      <input
        key={sessionId}
        ref={inputRef}
        type="file"
        multiple
        className="composer__file-input"
        aria-label="Attach files"
        tabIndex={-1}
        disabled={disabled}
        onChange={(event) => {
          void addFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
    ),
    button: (
      <button
        type="button"
        className="icon-button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        aria-label="Attach files"
        title="Attach, paste, or drop files"
      >
        <Paperclip size={14} aria-hidden />
      </button>
    ),
  };
}
