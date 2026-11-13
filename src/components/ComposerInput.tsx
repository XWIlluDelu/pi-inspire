import { Maximize2, Minimize2 } from "lucide-react";
import {
  type ClipboardEventHandler,
  type CSSProperties,
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
  rankProjectFiles,
  replaceCompletionToken,
  replaceFileCompletion,
  resolveCommandInventory,
} from "../composer-completion";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { useFloatingMenuDismissal } from "../use-floating-menu";
import { HiddenFilesToggle } from "./HiddenFilesToggle";
import { type ListOption, OptionList, useOptionList } from "./OptionList";
import { ProjectFileLabel } from "./ProjectFiles";

interface CompletionItem {
  key: string;
  title: string;
  hint?: string;
  group: string;
  file?: ProjectFileResult;
  command?: PiCommand;
  argument?: string;
}

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
  const renderItem = ({ value: item }: ListOption<CompletionItem>) =>
    item.file ? (
      <ProjectFileLabel
        path={item.file.path}
        name={item.title}
        query={token.query}
        captionClass="completion__hint"
      />
    ) : (
      <>
        <span className="completion__title">
          {item.command ? `/${item.command.name}` : item.title}
          {item.command?.argumentHint && (
            <span className="completion__arguments">
              {" "}
              {item.command.argumentHint}
            </span>
          )}
        </span>
        {item.hint && <span className="completion__hint">{item.hint}</span>}
      </>
    );
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
        className="completion__list"
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
  maxHeightRatio = 0.4,
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
  maxHeightRatio?: number;
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
  const [completionTruncated, setCompletionTruncated] = useState(false);
  const [completion, setCompletion] = useState<CaretCompletion | null>(null);
  const [completionFiles, setCompletionFiles] = useState<ProjectFileResult[]>(
    [],
  );
  const [completionStatus, setCompletionStatus] = useState<
    "loading" | "ready" | "error"
  >("ready");
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

  useEffect(() => {
    if (completion?.kind !== "file" || !searchProjectFiles) {
      setCompletionFiles([]);
      setCompletionStatus("ready");
      return;
    }
    let cancelled = false;
    setCompletionFiles([]);
    setCompletionTruncated(false);
    setCompletionStatus("loading");
    const timer = setTimeout(() => {
      searchProjectFiles(completion.query).then(
        (result) => {
          if (!cancelled) {
            setCompletionFiles(
              rankProjectFiles(result.files, completion.query),
            );
            setCompletionTruncated(Boolean(result.truncated));
            setCompletionStatus("ready");
          }
        },
        () => {
          if (!cancelled) setCompletionStatus("error");
        },
      );
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [completion, completionScope, searchProjectFiles, showHiddenFiles]);

  const completionItems = useMemo<CompletionItem[]>(() => {
    if (!completion) return [];
    if (completion.kind === "file") {
      return completionFiles.map((file) => ({
        key: file.path,
        title: file.name,
        hint: file.path,
        group: "Project files",
        file,
      }));
    }
    if (completion.kind === "argument") {
      return commandArgumentCandidates(completion, models, activeModel).map(
        (candidate) => ({
          key: candidate.value,
          title: candidate.value,
          hint: candidate.hint,
          group:
            completion.name === "model"
              ? "Available models"
              : "Supported thinking levels",
          argument: candidate.value,
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
      title: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
      hint:
        command.execution === "terminal"
          ? `Terminal only — ${command.description ?? "Run in Pi's terminal"}`
          : command.description,
      group:
        command.source === "builtin"
          ? "Pi"
          : command.source
            ? `${command.source[0]!.toUpperCase()}${command.source.slice(1)}`
            : "Command",
      command,
    }));
  }, [commandInventory, completion, completionFiles, models, activeModel]);

  const options = useMemo(
    () =>
      completionItems.map(
        (item): ListOption<CompletionItem> => ({
          key: item.key,
          value: item,
          group: item.file && onShowHiddenFilesChange ? undefined : item.group,
          title: item.file?.path,
          label: item.file ? `${item.title}, ${item.file.path}` : undefined,
        }),
      ),
    [completionItems, onShowHiddenFilesChange],
  );

  const pickCompletion = (item: CompletionItem | undefined) => {
    if (!item || !completion || completionDisabled) return;
    const existingDelimiter = value[completion.end];
    const reusesInlineDelimiter = Boolean(
      item.command && existingDelimiter && /[ \t]/.test(existingDelimiter),
    );
    const addsArgumentDelimiter = Boolean(
      item.command &&
        (item.command.source !== "builtin" || item.command.argumentHint),
    );
    const replacement = item.command
      ? `/${item.command.name}${reusesInlineDelimiter || !addsArgumentDelimiter ? "" : " "}`
      : (item.argument ?? "");
    const inserted = item.file
      ? replaceFileCompletion(value, completion, item.file)
      : replaceCompletionToken(value, completion, replacement);
    const next = reusesInlineDelimiter
      ? { ...inserted, caret: inserted.caret + 1 }
      : inserted;
    inputValueRef.current = next.value;
    const nextArgument =
      item.command?.source === "builtin" &&
      ["model", "thinking"].includes(item.command.name)
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
          style={
            {
              "--editor-compact-height": `${maxHeightRatio * 100}dvh`,
            } as CSSProperties
          }
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
      {commandUsageHint(value, includeNativeCommands) ? (
        <div className="composer__usage" role="note">
          {commandUsageHint(value, includeNativeCommands)}
        </div>
      ) : null}
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
