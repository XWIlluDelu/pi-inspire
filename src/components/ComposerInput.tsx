import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
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
import { createPortal } from "react-dom";
import type { ComposerHistoryEntry, ModelOption } from "../../shared/contracts";
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
import {
  isTextareaCaretOnVisualEdge,
  textareaCaretLineBounds,
} from "../composer-history";
import {
  type FloatingMenuConstraints,
  type FloatingMenuPlacement,
  useFloatingMenuPlacement,
} from "../use-floating-menu";
import { useModalPortal } from "../use-modal-focus";
import { HiddenFilesToggle } from "./HiddenFilesToggle";

const COMPLETION_MENU_CONSTRAINTS: FloatingMenuConstraints = {
  gap: 8,
  horizontalMargin: 16,
  verticalMargin: 8,
  maxWidth: Number.POSITIVE_INFINITY,
  maxHeight: 320,
};

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
  id,
  token,
  items,
  active,
  status,
  truncated,
  showHiddenFiles,
  onShowHiddenFilesChange,
  placement,
  onActive,
  onPick,
  anchorRef,
}: {
  id: string;
  token: CaretCompletion;
  items: CompletionItem[];
  active: number;
  status: "loading" | "ready" | "error";
  truncated: boolean;
  showHiddenFiles: boolean;
  onShowHiddenFilesChange?: (value: boolean) => void;
  placement: FloatingMenuPlacement | null;
  onActive: (index: number) => void;
  onPick: (item: CompletionItem) => void;
  anchorRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useModalPortal(true, anchorRef, menuRef);
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const virtualized = items.length > 50;
  const fileControls =
    token.kind === "file" && Boolean(onShowHiddenFilesChange);
  const hasHeading = useCallback(
    (index: number) =>
      items[index]?.group !== items[index - 1]?.group && !fileControls,
    [items, fileControls],
  );
  const getItemKey = useCallback((index: number) => items[index]!.key, [items]);
  const estimateSize = useCallback(
    (index: number) => 48 + (hasHeading(index) ? 28 : 0),
    [hasHeading],
  );
  const virtualizer = useVirtualizer({
    enabled: virtualized,
    count: items.length,
    getScrollElement: () => menuRef.current,
    getItemKey,
    estimateSize,
    scrollMargin: listRef.current?.offsetTop ?? 0,
    overscan: 4,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      // Keyboard navigation keeps its active descendant mounted offscreen.
      if (!indexes.includes(active)) indexes.push(active);
      return indexes.sort((left, right) => left - right);
    },
  });
  useLayoutEffect(() => {
    if (virtualized) virtualizer.scrollToIndex(active, { align: "auto" });
    else refs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, items, virtualized, virtualizer]);
  const renderItem = (item: CompletionItem, index: number) => (
    <>
      {hasHeading(index) ? (
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
        aria-posinset={index + 1}
        aria-setsize={items.length}
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
    </>
  );
  return (
    <div
      ref={menuRef}
      className="completion"
      onClick={(event) => event.stopPropagation()}
      data-placement={placement?.direction}
      style={
        placement
          ? {
              left: placement.left,
              top: placement.top,
              bottom: placement.bottom,
              width: placement.width,
              maxHeight: placement.maxHeight,
            }
          : { visibility: "hidden" }
      }
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
      <div
        ref={listRef}
        id={id}
        role="listbox"
        aria-label={
          token.kind === "file"
            ? "Project file completions"
            : token.kind === "argument"
              ? `${token.name === "model" ? "Model" : "Thinking level"} argument completions`
              : "Slash command completions"
        }
        aria-busy={status === "loading"}
      >
        {virtualized ? (
          <div
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((row) => (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: row.start - virtualizer.options.scrollMargin,
                  left: 0,
                  width: "100%",
                }}
              >
                {renderItem(items[row.index]!, row.index)}
              </div>
            ))}
          </div>
        ) : (
          items.map((item, index) => (
            <div key={item.key}>{renderItem(item, index)}</div>
          ))
        )}
        {truncated ? (
          <div className="completion__empty" role="status">
            Partial search results
          </div>
        ) : null}
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
                  : token.kind === "argument"
                    ? "No available candidates"
                    : "No matching commands"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ComposerInput({
  value,
  onChange,
  onHistoryPreview,
  onHistoryCommit,
  onHistoryCancel,
  history = [],
  commands,
  models = [],
  activeModel = null,
  includeNativeCommands = true,
  completionDisabled = false,
  disabled = false,
  completionScope,
  completionPortal,
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
  onHistoryPreview?: (
    value: string,
    entry: ComposerHistoryEntry | null,
  ) => void;
  onHistoryCommit?: () => void;
  onHistoryCancel?: () => void;
  history?: readonly ComposerHistoryEntry[];
  commands: readonly PiCommand[];
  models?: readonly ModelOption[];
  activeModel?: ModelOption | null;
  includeNativeCommands?: boolean;
  completionDisabled?: boolean;
  disabled?: boolean;
  completionScope?: string | null;
  /** Mount within the active overlay, not above unrelated dialogs. */
  completionPortal?: RefObject<HTMLElement | null>;
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
  const completionId = useId();
  const editorId = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [completionTruncated, setCompletionTruncated] = useState(false);
  const [completion, setCompletion] = useState<CaretCompletion | null>(null);
  const [completionFiles, setCompletionFiles] = useState<ProjectFileResult[]>(
    [],
  );
  const [completionStatus, setCompletionStatus] = useState<
    "loading" | "ready" | "error"
  >("ready");
  const [completionActive, setCompletionActive] = useState(0);
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
  const inputValueRef = useRef(value);
  const historyIndexRef = useRef(-1);
  const historyDraftRef = useRef<{
    value: string;
    start: number;
    end: number;
    direction: "forward" | "backward" | "none";
    scrollTop: number;
  } | null>(null);
  const historyPreviewValueRef = useRef<string | null>(null);
  const pendingSelectionRef = useRef(0);
  const resolveCompletionMenuTarget = useCallback(() => {
    const inputWrap = inputWrapRef.current;
    const textarea = textareaRef.current;
    if (!inputWrap || !textarea) return null;
    const horizontal = inputWrap.getBoundingClientRect();
    const vertical =
      textareaCaretLineBounds(textarea, completion?.end) ??
      textarea.getBoundingClientRect();
    return {
      context: inputWrap,
      anchor: {
        left: horizontal.left,
        right: horizontal.right,
        top: vertical.top,
        bottom: vertical.bottom,
      },
      preferredWidth: horizontal.width,
      observe: [inputWrap, textarea],
    };
  }, [completion?.end]);
  const completionPlacement = useFloatingMenuPlacement(
    completion !== null,
    resolveCompletionMenuTarget,
    COMPLETION_MENU_CONSTRAINTS,
  );

  const exitHistoryBrowsing = useCallback(() => {
    historyIndexRef.current = -1;
    historyDraftRef.current = null;
    historyPreviewValueRef.current = null;
  }, []);

  const resizeEditor = useCallback(() => {
    const element = textareaRef.current;
    const wrap = inputWrapRef.current;
    if (!element || !wrap) return;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const main = wrap.closest("main");
    const composer = wrap.closest(".composer");
    const dock = wrap.closest(".composer-dock");
    const chrome = composer
      ? composer.getBoundingClientRect().height -
        element.getBoundingClientRect().height
      : 0;
    const dockChrome =
      dock && composer
        ? dock.getBoundingClientRect().height -
          composer.getBoundingClientRect().height
        : 0;
    const available = Math.max(
      48,
      Math.min(
        viewportHeight * 0.8,
        Math.min(
          main?.getBoundingClientRect().height || viewportHeight,
          viewportHeight,
        ) -
          chrome -
          dockChrome -
          64,
      ),
    );
    const limit = expanded
      ? available
      : Math.min(viewportHeight * maxHeightRatio, available);
    const scrollTop = element.scrollTop;
    element.style.maxHeight = `${limit}px`;
    element.style.height = "auto";
    element.style.height = `${expanded ? limit : Math.min(element.scrollHeight, limit)}px`;
    element.scrollTop = scrollTop;
    setOverflowing(element.scrollHeight > element.clientHeight + 1);
  }, [expanded, maxHeightRatio]);

  useLayoutEffect(() => {
    resizeEditor();
  }, [resizeEditor, value]);

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resizeEditor);
    };
    const wrap = inputWrapRef.current;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    if (wrap) {
      observer?.observe(wrap);
      const main = wrap.closest("main");
      if (main) observer?.observe(main);
    }
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [resizeEditor]);

  useEffect(() => {
    if (
      historyIndexRef.current >= 0 &&
      value !== historyPreviewValueRef.current
    ) {
      onHistoryCancel?.();
      exitHistoryBrowsing();
    }
    if (value !== inputValueRef.current) {
      setCompletion(null);
    }
    inputValueRef.current = value;
  }, [value, exitHistoryBrowsing, onHistoryCancel]);

  useEffect(() => {
    setCompletion(null);
    onHistoryCancel?.();
    exitHistoryBrowsing();
  }, [completionScope, exitHistoryBrowsing, onHistoryCancel]);

  useEffect(() => {
    if (completionDisabled) exitHistoryBrowsing();
    setCompletion(null);
  }, [completionDisabled, exitHistoryBrowsing]);

  const updateCompletion = (draft: string, caret: number | null) => {
    if (
      composingRef.current ||
      completionDisabled ||
      historyIndexRef.current >= 0 ||
      caret === null
    ) {
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
    setCompletionActive(0);
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
    exitHistoryBrowsing();
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
    setCompletion(nextArgument);
  };

  const previewHistory = (
    nextValue: string,
    entry: ComposerHistoryEntry | null,
    start: number,
    end: number,
    direction: "forward" | "backward" | "none",
    scrollTop: number | "start" | "end",
  ) => {
    const nonce = ++pendingSelectionRef.current;
    historyPreviewValueRef.current = nextValue;
    inputValueRef.current = nextValue;
    if (onHistoryPreview) onHistoryPreview(nextValue, entry);
    else onChange(nextValue);
    setCompletion(null);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (
        nonce !== pendingSelectionRef.current ||
        !element ||
        element.value !== nextValue
      )
        return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(start, end, direction);
      element.scrollTop =
        scrollTop === "start"
          ? 0
          : scrollTop === "end"
            ? element.scrollHeight
            : scrollTop;
    });
  };

  const navigateHistory = (direction: -1 | 1, element: HTMLTextAreaElement) => {
    if (history.length === 0) return;
    const current = historyIndexRef.current;
    if (direction === -1) {
      const next = Math.min(current + 1, history.length - 1);
      if (current === -1) {
        historyDraftRef.current = {
          value: element.value,
          start: element.selectionStart,
          end: element.selectionEnd,
          direction: element.selectionDirection,
          scrollTop: element.scrollTop,
        };
      }
      historyIndexRef.current = next;
      const entry = history[next];
      const nextValue = entry?.text ?? "";
      previewHistory(nextValue, entry ?? null, 0, 0, "none", "start");
      return;
    }
    if (current < 0) return;
    if (current === 0) {
      const draft = historyDraftRef.current;
      exitHistoryBrowsing();
      const nextValue = draft?.value ?? "";
      previewHistory(
        nextValue,
        null,
        draft?.start ?? nextValue.length,
        draft?.end ?? nextValue.length,
        draft?.direction ?? "none",
        draft?.scrollTop ?? "end",
      );
      historyPreviewValueRef.current = null;
      return;
    }
    const next = current - 1;
    historyIndexRef.current = next;
    const entry = history[next];
    const nextValue = entry?.text ?? "";
    previewHistory(
      nextValue,
      entry ?? null,
      nextValue.length,
      nextValue.length,
      "none",
      "end",
    );
  };

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (event.nativeEvent.isComposing || composingRef.current) return;
    if (completion) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissedCompletionRef.current = {
          value: event.currentTarget.value,
          caret: event.currentTarget.selectionStart,
        };
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
    if (
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.currentTarget.selectionStart === event.currentTarget.selectionEnd &&
      history.length > 0
    ) {
      const element = event.currentTarget;
      const caret = element.selectionStart;
      if (
        event.key === "ArrowUp" &&
        isTextareaCaretOnVisualEdge(element, "first")
      ) {
        event.preventDefault();
        const lineStart = element.value.lastIndexOf("\n", caret - 1) + 1;
        if (
          element.value === "" ||
          historyIndexRef.current >= 0 ||
          caret === lineStart
        ) {
          navigateHistory(-1, element);
        } else {
          element.setSelectionRange(lineStart, lineStart);
        }
        return;
      }
      if (
        event.key === "ArrowDown" &&
        isTextareaCaretOnVisualEdge(element, "last")
      ) {
        event.preventDefault();
        if (historyIndexRef.current >= 0) {
          navigateHistory(1, element);
        } else {
          const newline = element.value.indexOf("\n", caret);
          const lineEnd = newline < 0 ? element.value.length : newline;
          element.setSelectionRange(lineEnd, lineEnd);
        }
        return;
      }
    }
    onKeyDown?.(event);
  };

  return (
    <>
      <div
        ref={inputWrapRef}
        className={`composer__input-wrap${expanded ? " composer__input-wrap--expanded" : ""}`}
        role="combobox"
        aria-label={completionLabel}
        aria-haspopup="listbox"
        aria-expanded={Boolean(completion)}
        aria-owns={completion ? completionId : undefined}
      >
        <textarea
          ref={textareaRef}
          id={editorId}
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
          disabled={disabled}
          onChange={(event) => {
            completionSelectionRef.current = null;
            pendingSelectionRef.current++;
            if (historyIndexRef.current >= 0) onHistoryCommit?.();
            exitHistoryBrowsing();
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
        {expanded || overflowing ? (
          <button
            type="button"
            className="composer__expand icon-button"
            aria-label={expanded ? "Collapse editor" : "Expand editor"}
            title={expanded ? "Collapse editor" : "Expand editor"}
            aria-expanded={expanded}
            aria-controls={editorId}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const element = textareaRef.current;
              const start = element?.selectionStart ?? 0;
              const end = element?.selectionEnd ?? start;
              const direction = element?.selectionDirection ?? "none";
              setExpanded((current) => !current);
              element?.focus({ preventScroll: true });
              element?.setSelectionRange(start, end, direction);
            }}
          >
            {expanded ? (
              <Minimize2 size={16} aria-hidden />
            ) : (
              <Maximize2 size={16} aria-hidden />
            )}
          </button>
        ) : null}
      </div>
      {commandUsageHint(value, includeNativeCommands) ? (
        <div className="composer__usage" role="note">
          {commandUsageHint(value, includeNativeCommands)}
        </div>
      ) : null}
      {completion
        ? createPortal(
            <CompletionMenu
              id={completionId}
              token={completion}
              items={completionItems}
              active={activeIndex}
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
              placement={completionPlacement}
              onActive={setCompletionActive}
              onPick={pickCompletion}
              anchorRef={textareaRef}
            />,
            completionPortal?.current ?? document.body,
          )
        : null}
    </>
  );
}
