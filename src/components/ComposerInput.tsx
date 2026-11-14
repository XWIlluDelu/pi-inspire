import { Maximize2, Minimize2 } from "lucide-react";
import {
  type ClipboardEventHandler,
  type KeyboardEventHandler,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ModelOption } from "../../shared/contracts";
import type { ProjectFileResult, ProjectFileSearchResult } from "../api";
import {
  type CaretCompletion,
  commandArgumentCandidates,
  commandUsageHint,
  type PiCommand,
  parseCaretCompletion,
  rankCommands,
  replaceCompletionToken,
  replaceFileCompletion,
  resolveCommandInventory,
} from "../composer-completion";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { useFloatingMenuDismissal } from "../use-floating-menu";
import { HiddenFilesToggle } from "./HiddenFilesToggle";
import { type ListOption, OptionList, useOptionList } from "./OptionList";
import { ProjectFileLabel, useProjectFileSearch } from "./ProjectFiles";

type CompletionItem =
  | { kind: "file"; file: ProjectFileResult }
  | { kind: "command"; command: PiCommand }
  | { kind: "argument"; text: string; hint?: string };

function CompletionMenu({
  list,
  token,
  options,
  status,
  truncated,
  showHiddenFiles,
  onShowHiddenFilesChange,
  onPick,
  onDismiss,
  anchorRef,
}: {
  list: ReturnType<typeof useOptionList<CompletionItem>>;
  token: CaretCompletion;
  options: readonly ListOption<CompletionItem>[];
  status: "loading" | "ready" | "error";
  truncated: boolean;
  showHiddenFiles: boolean;
  onShowHiddenFilesChange?: (value: boolean) => void;
  onPick: (item: CompletionItem) => void;
  onDismiss: () => void;
  anchorRef: RefObject<HTMLDivElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useFloatingMenuDismissal(true, anchorRef, menuRef, onDismiss);
  const renderItem = ({ value: item }: ListOption<CompletionItem>) => {
    if (item.kind === "file")
      return (
        <ProjectFileLabel
          path={item.file.path}
          name={item.file.name}
          query={token.query}
          captionClass="completion__hint"
        />
      );
    const command = item.kind === "command" ? item.command : null;
    const hint =
      item.kind === "argument"
        ? item.hint
        : item.command.execution === "terminal"
          ? `Terminal only — ${item.command.description ?? "Run in Pi's terminal"}`
          : item.command.description;
    return (
      <>
        <span className="completion__title">
          {item.kind === "argument" ? item.text : `/${item.command.name}`}
          {command?.argumentHint && (
            <span className="completion__arguments">
              {" "}
              {command.argumentHint}
            </span>
          )}
        </span>
        {hint && <span className="completion__hint">{hint}</span>}
      </>
    );
  };
  return (
    <div
      ref={menuRef}
      className="completion"
      onClick={(event) => event.stopPropagation()}
    >
      {token.kind === "file" && onShowHiddenFilesChange ? (
        <div
          className="file-search-controls"
          onMouseDown={(event) => event.preventDefault()}
        >
          <span className="completion__heading">Project files</span>
          <HiddenFilesToggle
            showHidden={showHiddenFiles}
            onChange={onShowHiddenFilesChange}
          />
        </div>
      ) : null}
      <OptionList
        list={list}
        options={options}
        optionClass="completion__option"
        onPick={onPick}
        highlightAsSelection
        heading={({ group }) => (
          <div className="completion__heading" aria-hidden>
            {group}
          </div>
        )}
        renderOption={renderItem}
        label={
          token.kind === "file"
            ? "Project file completions"
            : token.kind === "argument"
              ? `${token.name === "model" ? "Model" : "Thinking level"} argument completions`
              : "Slash command completions"
        }
        loading={status === "loading"}
      >
        {truncated ? (
          <div className="picker__empty" role="status">
            Partial search results
          </div>
        ) : null}
        {options.length === 0 ? (
          <div
            className="picker__empty"
            data-error={status === "error"}
            role="status"
          >
            {status === "loading"
              ? "Searching project files…"
              : status === "error"
                ? "Project file search failed"
                : token.kind === "file"
                  ? "No matching project files"
                  : token.kind === "argument"
                    ? "No available candidates"
                    : "No matching commands"}
          </div>
        ) : null}
      </OptionList>
    </div>
  );
}

export function ComposerInput({
  value,
  onChange,
  commands,
  models = [],
  activeModel = null,
  includeNativeCommands = true,
  completionDisabled = false,
  disabled = false,
  completionScope,
  searchProjectFiles,
  showHiddenFiles = false,
  onShowHiddenFilesChange,
  rows = 1,
  placeholder,
  label,
  completionLabel = "Message completion",
  autoFocus = false,
  initialCaretAtEnd = false,
  onPaste,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  commands: readonly PiCommand[];
  models?: readonly ModelOption[];
  activeModel?: ModelOption | null;
  includeNativeCommands?: boolean;
  completionDisabled?: boolean;
  disabled?: boolean;
  completionScope?: string | null;
  searchProjectFiles?: (query: string) => Promise<ProjectFileSearchResult>;
  showHiddenFiles?: boolean;
  onShowHiddenFilesChange?: (value: boolean) => void;
  rows?: number;
  placeholder: string;
  label: string;
  completionLabel?: string;
  autoFocus?: boolean;
  initialCaretAtEnd?: boolean;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
}) {
  const completionList = useOptionList<CompletionItem>();
  const editorId = useId();
  const [expanded, setExpanded] = useState(false);
  const [completion, setCompletion] = useState<CaretCompletion | null>(null);
  const {
    files: completionFiles,
    status: completionStatus,
    truncated: completionTruncated,
  } = useProjectFileSearch(
    searchProjectFiles,
    completion?.kind === "file" && !completionDisabled
      ? completion.query
      : undefined,
    completionScope,
    showHiddenFiles,
    140,
  );
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Let an enclosing modal capture its opener before moving focus.
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const composingRef = useRef(false);
  const completionSelectionRef = useRef<{
    value: string;
    caret: number;
  } | null>(null);
  useLayoutEffect(() => {
    const selection = completionSelectionRef.current;
    const input = textareaRef.current;
    if (!selection || !input || selection.value !== value) return;
    completionSelectionRef.current = null;
    input.focus();
    input.setSelectionRange(selection.caret, selection.caret);
  });
  const initialCaretRef = useRef(initialCaretAtEnd);
  useLayoutEffect(() => {
    const input = textareaRef.current;
    if (input && initialCaretRef.current)
      input.setSelectionRange(input.value.length, input.value.length);
  }, []);
  const dismissedCompletionRef = useRef<{
    value: string;
    caret: number;
  } | null>(null);
  const dismissCompletion = useCallback(() => {
    const input = textareaRef.current;
    if (input) {
      dismissedCompletionRef.current = {
        value: input.value,
        caret: input.selectionStart,
      };
    }
    setCompletion(null);
  }, []);
  const inputValueRef = useRef(value);
  useEffect(() => {
    if (value !== inputValueRef.current) setCompletion(null);
    inputValueRef.current = value;
  }, [value]);

  useEffect(() => {
    setCompletion(null);
  }, [completionScope, completionDisabled]);

  const updateCompletion = (draft: string, caret: number | null) => {
    if (composingRef.current || completionDisabled || caret === null) {
      setCompletion(null);
      return;
    }
    // Browsers can emit a delayed selection event after layout/focus changes.
    // It must not reopen an explicitly dismissed menu at the unchanged caret.
    if (
      dismissedCompletionRef.current?.value === draft &&
      dismissedCompletionRef.current.caret === caret
    ) {
      setCompletion(null);
      return;
    }
    dismissedCompletionRef.current = null;
    const token = parseCaretCompletion(draft, caret);
    completionList.reset(true);
    setCompletion(
      (token?.kind === "file" && !searchProjectFiles) ||
        (token?.kind === "argument" && !includeNativeCommands)
        ? null
        : token,
    );
  };

  const commandInventory = useMemo(
    () => resolveCommandInventory(commands, includeNativeCommands),
    [commands, includeNativeCommands],
  );

  const options = useMemo<ListOption<CompletionItem>[]>(() => {
    if (!completion) return [];
    if (completion.kind === "file") {
      return completionFiles.map((file) => ({
        key: file.path,
        title: file.path,
        label: `${file.name}, ${file.path}`,
        group: onShowHiddenFilesChange ? undefined : "Project files",
        value: { kind: "file", file },
      }));
    }
    if (completion.kind === "argument") {
      return commandArgumentCandidates(completion, models, activeModel).map(
        ({ value, hint }) => ({
          key: value,
          group:
            completion.name === "model"
              ? "Available models"
              : "Supported thinking levels",
          value: { kind: "argument", text: value, hint },
        }),
      );
    }
    const ranked = rankCommands(commandInventory, completion.query);
    if (!completion.query.trim()) {
      const sourceOrder = new Map(
        ["builtin", "extension", "prompt", "skill"].map((source, index) => [
          source,
          index,
        ]),
      );
      ranked.sort(
        (left, right) =>
          (sourceOrder.get(left.source ?? "") ?? 99) -
          (sourceOrder.get(right.source ?? "") ?? 99),
      );
    }
    return ranked.map((command) => ({
      key: `${command.source ?? "command"}:${command.name}`,
      group:
        command.source === "builtin"
          ? "Pi"
          : command.source
            ? `${command.source[0]!.toUpperCase()}${command.source.slice(1)}`
            : "Command",
      value: { kind: "command", command },
    }));
  }, [
    commandInventory,
    completion,
    completionFiles,
    models,
    activeModel,
    onShowHiddenFilesChange,
  ]);

  const pickCompletion = (item: CompletionItem | undefined) => {
    if (!item || !completion || completionDisabled) return;
    const command = item.kind === "command" ? item.command : undefined;
    const existingDelimiter = value[completion.end];
    const reusesInlineDelimiter = Boolean(
      command && existingDelimiter && /[ \t]/.test(existingDelimiter),
    );
    const addsArgumentDelimiter = Boolean(
      command && (command.source !== "builtin" || command.argumentHint),
    );
    const replacement = command
      ? `/${command.name}${reusesInlineDelimiter || !addsArgumentDelimiter ? "" : " "}`
      : item.kind === "argument"
        ? item.text
        : "";
    const inserted =
      item.kind === "file"
        ? replaceFileCompletion(value, completion, item.file)
        : replaceCompletionToken(value, completion, replacement);
    const next = reusesInlineDelimiter
      ? { ...inserted, caret: inserted.caret + 1 }
      : inserted;
    inputValueRef.current = next.value;
    const nextArgument =
      command?.source === "builtin" &&
      ["model", "thinking"].includes(command.name)
        ? parseCaretCompletion(next.value, next.caret)
        : null;
    dismissedCompletionRef.current = nextArgument
      ? null
      : { value: next.value, caret: next.caret };
    completionSelectionRef.current = next;
    onChange(next.value);
    completionList.reset(true);
    setCompletion(nextArgument);
  };

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (isComposingKeyboardEvent(event.nativeEvent) || composingRef.current)
      return;
    if (completion) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissCompletion();
        return;
      }
      if (
        completionList.navigate(event, options, pickCompletion, {
          tab: true,
          excludeAltUp: true,
        })
      )
        return;
    }
    onKeyDown?.(event);
  };

  const usage = commandUsageHint(value, includeNativeCommands);
  return (
    <>
      <div
        ref={inputWrapRef}
        className="composer__input-wrap"
        role="combobox"
        aria-label={completionLabel}
        aria-haspopup="listbox"
        aria-expanded={Boolean(completion)}
        aria-owns={completion ? completionList.id : undefined}
      >
        <textarea
          ref={textareaRef}
          id={editorId}
          className="composer__input"
          data-expanded={expanded || undefined}
          aria-autocomplete="list"
          aria-controls={completion ? completionList.id : undefined}
          aria-activedescendant={
            completion ? completionList.descendant(options) : undefined
          }
          rows={rows}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => {
            completionSelectionRef.current = null;
            inputValueRef.current = event.target.value;
            onChange(event.target.value);
            updateCompletion(event.target.value, event.target.selectionStart);
          }}
          onSelect={(event) =>
            updateCompletion(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            )
          }
          onKeyUp={(event) => {
            if (
              ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
            ) {
              updateCompletion(
                event.currentTarget.value,
                event.currentTarget.selectionStart,
              );
            }
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            setCompletion(null);
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            updateCompletion(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            );
          }}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          aria-label={label}
          spellCheck={false}
          autoCorrect="off"
          data-modal-autofocus={autoFocus || undefined}
        />
        {completion && (
          <CompletionMenu
            list={completionList}
            token={completion}
            options={options}
            status={completion.kind === "file" ? completionStatus : "ready"}
            truncated={completion.kind === "file" && completionTruncated}
            showHiddenFiles={showHiddenFiles}
            onShowHiddenFilesChange={
              onShowHiddenFilesChange
                ? (value) => {
                    onShowHiddenFilesChange(value);
                    textareaRef.current?.focus();
                  }
                : undefined
            }
            onPick={pickCompletion}
            onDismiss={dismissCompletion}
            anchorRef={inputWrapRef}
          />
        )}
      </div>
      {usage && (
        <div className="composer__usage" role="note">
          {usage}
        </div>
      )}
      {value || expanded ? (
        <button
          type="button"
          className="composer__size-action icon-button"
          aria-label={expanded ? "Collapse editor" : "Expand editor"}
          title={expanded ? "Collapse editor" : "Expand editor"}
          aria-expanded={expanded}
          aria-controls={editorId}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setExpanded(!expanded);
            textareaRef.current?.focus({ preventScroll: true });
          }}
        >
          {expanded ? (
            <Minimize2 size={16} aria-hidden />
          ) : (
            <Maximize2 size={16} aria-hidden />
          )}
        </button>
      ) : null}
    </>
  );
}
