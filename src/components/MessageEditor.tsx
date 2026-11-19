import { Paperclip, Send } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { clipboardFiles } from "../clipboard-files";
import { shouldSubmitComposerEnter } from "../composer-keyboard";
import type { SessionDraft } from "../session-drafts";
import { store, useAppState } from "../store";
import { AttachmentList } from "./AttachmentList";
import { ComposerInput } from "./ComposerInput";
import { PiLoader } from "./PiLoader";
import { ProjectFileChips, ProjectFileControl } from "./ProjectFiles";

type EditorProps = ComponentProps<typeof ComposerInput>;
type FileSearch = NonNullable<EditorProps["searchProjectFiles"]>;

/** One draft editor for New and an open session. The caller owns submission. */
export function MessageEditor({
  sessionId,
  draft,
  className = "",
  label,
  disabled = false,
  busy,
  header,
  beforeInput,
  afterInput,
  selectors,
  actions,
  send,
  children,
  files,
  input,
  beforeEdit = () => true,
  onSubmit,
}: {
  sessionId: string | null;
  draft: SessionDraft;
  className?: string;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  header?: ReactNode;
  beforeInput?: ReactNode;
  afterInput?: ReactNode;
  selectors: ReactNode;
  actions?: ReactNode;
  send?: { label: string; title?: string; disabled: boolean; busy?: boolean };
  children?: ReactNode;
  files: {
    scope: string | null;
    search: FileSearch;
    showHidden: boolean;
    onShowHiddenChange(value: boolean): void;
    pickerDisabled?: boolean;
  };
  input: Omit<
    EditorProps,
    | "value"
    | "onChange"
    | "onPaste"
    | "disabled"
    | "completionDisabled"
    | "searchProjectFiles"
    | "showHiddenFiles"
    | "onShowHiddenFilesChange"
  >;
  beforeEdit?(): boolean;
  onSubmit(): void;
}) {
  const sendKey = useAppState((state) => state.prefs.desktopSendKey);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [sizeActionSlot, setSizeActionSlot] = useState<HTMLSpanElement | null>(
    null,
  );
  useLayoutEffect(() => setDragging(false), [sessionId]);
  const addFiles = (attachments: File[]) => {
    if (!disabled && attachments.length && beforeEdit())
      void store.addFiles(attachments, sessionId);
  };
  const submit = () => {
    if (!disabled && store.getState().sessionId === sessionId) onSubmit();
  };

  return (
    <form
      className={`composer ${className}${dragging ? " composer--drop" : ""}`}
      aria-label={label}
      aria-busy={busy || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
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
          addFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      {header}
      <AttachmentList
        sessionId={sessionId}
        items={draft.attachments}
        disabled={disabled}
        onRemove={(id) => {
          if (beforeEdit()) store.removeAttachment(id, sessionId);
        }}
        onRetry={sessionId ? store.retryAttachment : undefined}
      />
      <ProjectFileChips
        paths={draft.projectFiles}
        disabled={disabled}
        onRemove={(path) => {
          if (beforeEdit()) store.removeProjectFile(path, sessionId);
        }}
      />
      {beforeInput}
      <ComposerInput
        {...input}
        key={sessionId ? input.completionScope : undefined}
        value={draft.text}
        onChange={(text) => {
          if (beforeEdit()) store.drafts.setText(sessionId, text);
        }}
        disabled={Boolean(sessionId) && disabled}
        completionDisabled={disabled}
        sizeActionSlot={sizeActionSlot}
        searchProjectFiles={files.scope ? files.search : undefined}
        showHiddenFiles={files.showHidden}
        onShowHiddenFilesChange={files.onShowHiddenChange}
        onKeyDown={(event) => {
          input.onKeyDown?.(event);
          if (
            event.defaultPrevented ||
            !shouldSubmitComposerEnter(event.nativeEvent, sendKey)
          )
            return;
          event.preventDefault();
          submit();
        }}
        onPaste={(event) => {
          const attachments = clipboardFiles(event.clipboardData);
          if (!attachments.length) return;
          event.preventDefault();
          addFiles(attachments);
        }}
      />
      {afterInput}
      <div className="composer__meta">
        <div className="composer__selectors">{selectors}</div>
        <div className="composer__actions">
          <ProjectFileControl
            key={files.scope}
            scope={files.scope}
            buttonDisabled={disabled || files.pickerDisabled}
            showHidden={files.showHidden}
            onShowHiddenChange={files.onShowHiddenChange}
            selected={draft.projectFiles}
            disabled={disabled}
            search={files.search}
            onAdd={(file) => {
              if (beforeEdit())
                store.addProjectFile(
                  file.path,
                  sessionId,
                  sessionId === null ? file.workspaceCwd : undefined,
                );
            }}
          />
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
          <span className="composer__action-slot" ref={setSizeActionSlot} />
          <span className="composer__spacer" />
          {actions}
          {send && (
            <button
              type="submit"
              className="composer__send"
              aria-label={send.label}
              title={send.title ?? send.label}
              disabled={send.disabled}
              aria-busy={send.busy}
            >
              {send.busy ? (
                <PiLoader size={14} aria-hidden />
              ) : (
                <Send size={14} aria-hidden />
              )}
            </button>
          )}
        </div>
      </div>
      {children}
    </form>
  );
}
