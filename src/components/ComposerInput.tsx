import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEventHandler,
  type KeyboardEventHandler,
} from "react";
import type { ProjectFileResult } from "../api";
import {
  parseCaretCompletion,
  rankCommands,
  rankProjectFiles,
  replaceCompletionToken,
  resolveCommandInventory,
  type CaretCompletion,
} from "../composer-completion";
import type { PiCommand } from "../store";

interface CompletionItem {
  key: string;
  title: string;
  hint?: string;
  group: string;
  file?: ProjectFileResult;
  command?: PiCommand;
}

function CompletionMenu({
  id,
  token,
  items,
  active,
  status,
  onActive,
  onPick,
}: {
  id: string;
  token: CaretCompletion;
  items: CompletionItem[];
  active: number;
  status: "loading" | "ready" | "error";
  onActive: (index: number) => void;
  onPick: (item: CompletionItem) => void;
}) {
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(() => {
    refs.current[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  let previousGroup = "";
  return (
    <div
      className="completion"
      id={id}
      role="listbox"
      aria-label={
        token.kind === "file"
          ? "Project file completions"
          : "Slash command completions"
      }
      aria-busy={status === "loading"}
    >
      {items.map((item, index) => {
        const heading = item.group !== previousGroup;
        previousGroup = item.group;
        return (
          <div key={item.key}>
            {heading ? (
              <div className="completion__heading" aria-hidden>
                {item.group}
              </div>
            ) : null}
            <div
              ref={(element) => {
                refs.current[index] = element;
              }}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === active}
              className={`completion__option ${index === active ? "completion__option--active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onActive(index)}
              onClick={() => onPick(item)}
            >
              <span className="completion__title">{item.title}</span>
              {item.hint ? (
                <span className="completion__hint">{item.hint}</span>
              ) : null}
            </div>
          </div>
        );
      })}
      {items.length === 0 ? (
        <div
          className={`completion__empty ${status === "error" ? "completion__empty--error" : ""}`}
          role="status"
        >
          {status === "loading"
            ? "Searching project files…"
            : status === "error"
              ? "Project file search failed"
              : token.kind === "file"
                ? "No matching project files"
                : "No matching commands"}
        </div>
      ) : null}
    </div>
  );
}

export function ComposerInput({
  value,
  onChange,
  commands,
  completionDisabled = false,
  completionScope,
  searchProjectFiles,
  onPickProjectFile,
  rows = 1,
  maxHeightRatio = 0.4,
  placeholder,
  label,
  completionLabel = "Message completion",
  autoFocus = false,
  onPaste,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  commands: readonly PiCommand[];
  completionDisabled?: boolean;
  completionScope?: string | null;
  searchProjectFiles?: (query: string) => Promise<ProjectFileResult[]>;
  onPickProjectFile?: (file: ProjectFileResult) => void;
  rows?: number;
  maxHeightRatio?: number;
  placeholder: string;
  label: string;
  completionLabel?: string;
  autoFocus?: boolean;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
}) {
  const completionId = useId();
  const [completion, setCompletion] = useState<CaretCompletion | null>(null);
  const [completionFiles, setCompletionFiles] = useState<ProjectFileResult[]>(
    [],
  );
  const [completionStatus, setCompletionStatus] = useState<
    "loading" | "ready" | "error"
  >("ready");
  const [completionActive, setCompletionActive] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const inputValueRef = useRef(value);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, Math.round(window.innerHeight * maxHeightRatio))}px`;
  }, [maxHeightRatio, value]);

  useEffect(() => {
    if (value !== inputValueRef.current) setCompletion(null);
    inputValueRef.current = value;
  }, [value]);

  useEffect(() => {
    setCompletion(null);
  }, [completionDisabled, completionScope]);

  const updateCompletion = (draft: string, caret: number | null) => {
    if (composingRef.current || completionDisabled || caret === null) {
      setCompletion(null);
      return;
    }
    const token = parseCaretCompletion(draft, caret);
    setCompletion(token?.kind === "file" && !searchProjectFiles ? null : token);
  };

  const commandInventory = useMemo(
    () => resolveCommandInventory(commands),
    [commands],
  );

  useEffect(() => {
    if (completion?.kind !== "file" || !searchProjectFiles) {
      setCompletionFiles([]);
      setCompletionStatus("ready");
      return;
    }
    let cancelled = false;
    setCompletionFiles([]);
    setCompletionStatus("loading");
    const timer = setTimeout(() => {
      searchProjectFiles(completion.query).then(
        (files) => {
          if (!cancelled) {
            setCompletionFiles(rankProjectFiles(files, completion.query));
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
  }, [completion, completionScope, searchProjectFiles]);

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
    const ranked = rankCommands(commandInventory, completion.query);
    if (!completion.query.trim()) {
      const sourceOrder = new Map(
        ["inspire", "extension", "prompt", "skill"].map((source, index) => [
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
      title: `/${command.name}`,
      hint: command.description,
      group: command.source
        ? `${command.source[0]!.toUpperCase()}${command.source.slice(1)}`
        : "Command",
      command,
    }));
  }, [commandInventory, completion, completionFiles]);

  useEffect(
    () => setCompletionActive(0),
    [completion?.kind, completion?.query],
  );
  const activeIndex = Math.min(
    completionActive,
    Math.max(0, completionItems.length - 1),
  );

  const pickCompletion = (item: CompletionItem | undefined) => {
    if (!item || !completion || completionDisabled) return;
    if (item.file) onPickProjectFile?.(item.file);
    const existingDelimiter = value[completion.end];
    const reusesInlineDelimiter = Boolean(
      item.command && existingDelimiter && /[ \t]/.test(existingDelimiter),
    );
    const replacement = item.command
      ? `/${item.command.name}${reusesInlineDelimiter ? "" : " "}`
      : "";
    const inserted = replaceCompletionToken(value, completion, replacement);
    const next = reusesInlineDelimiter
      ? { ...inserted, caret: inserted.caret + 1 }
      : inserted;
    inputValueRef.current = next.value;
    onChange(next.value);
    setCompletion(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (event.nativeEvent.isComposing || composingRef.current) return;
    if (completion) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCompletion(null);
        return;
      }
      if (event.key === "ArrowDown" && completionItems.length > 0) {
        event.preventDefault();
        setCompletionActive((index) =>
          Math.min(index + 1, completionItems.length - 1),
        );
        return;
      }
      if (event.key === "ArrowUp" && completionItems.length > 0) {
        event.preventDefault();
        setCompletionActive((index) => Math.max(0, index - 1));
        return;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.shiftKey &&
        completionItems[activeIndex]
      ) {
        event.preventDefault();
        pickCompletion(completionItems[activeIndex]);
        return;
      }
    }
    onKeyDown?.(event);
  };

  return (
    <>
      <div
        className="composer__input-wrap"
        role="combobox"
        aria-label={completionLabel}
        aria-haspopup="listbox"
        aria-expanded={Boolean(completion)}
        aria-owns={completion ? completionId : undefined}
      >
        <textarea
          ref={textareaRef}
          className="composer__input"
          aria-autocomplete="list"
          aria-controls={completion ? completionId : undefined}
          aria-activedescendant={
            completion && completionItems[activeIndex]
              ? `${completionId}-option-${activeIndex}`
              : undefined
          }
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(event) => {
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
          autoFocus={autoFocus}
        />
      </div>
      {completion ? (
        <CompletionMenu
          id={completionId}
          token={completion}
          items={completionItems}
          active={activeIndex}
          status={completion.kind === "file" ? completionStatus : "ready"}
          onActive={setCompletionActive}
          onPick={pickCompletion}
        />
      ) : null}
    </>
  );
}
