import { FolderSearch, X } from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ProjectFileResult, ProjectFileSearchResult } from "../api";
import { rankProjectFiles } from "../composer-completion";
import { fileIconForPath } from "../file-icons";
import {
  type FloatingMenuConstraints,
  useFloatingMenuPlacement,
} from "../use-floating-menu";
import { useModalPortal } from "../use-modal-focus";
import { useSearchFocus } from "../use-search-focus";
import { HiddenFilesToggle } from "./HiddenFilesToggle";
import { parentPath, ResourcePathLabel } from "./ResourcePathLabel";
import { SearchMatchText, searchMatchRanges } from "./SearchMatchText";

export function ProjectFileChips({
  paths,
  disabled = false,
  onRemove,
}: {
  paths: readonly string[];
  disabled?: boolean;
  onRemove: (path: string) => void;
}) {
  if (paths.length === 0) return null;
  return (
    <ul className="composer__attachments" aria-label="Referenced project files">
      {paths.map((path) => (
        <li key={path} className="attachment attachment--ready" title={path}>
          <FolderSearch size={13} aria-hidden />
          <ResourcePathLabel path={path} className="attachment__name" />
          <span className="attachment__meta">project file</span>
          <button
            type="button"
            className="attachment__remove"
            disabled={disabled}
            onClick={() => onRemove(path)}
            aria-label={`Remove ${path}`}
          >
            <X size={12} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

const PICKER_CONSTRAINTS: FloatingMenuConstraints = {
  gap: 4,
  horizontalMargin: 16,
  verticalMargin: 8,
  maxWidth: 420,
  maxHeight: 320,
};

export function ProjectFilePicker({
  anchorRef,
  scope,
  showHidden,
  onShowHiddenChange,
  selected,
  disabled = false,
  search,
  onAdd,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  scope: string;
  showHidden: boolean;
  onShowHiddenChange: (value: boolean) => void;
  selected: readonly string[];
  disabled?: boolean;
  search: (query: string) => Promise<ProjectFileSearchResult>;
  onAdd: (file: ProjectFileResult) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [results, setResults] = useState<ProjectFileResult[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [keyboardActive, setKeyboardActive] = useState(true);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resolveTarget = useCallback(() => {
    const anchor = anchorRef.current;
    return anchor
      ? {
          context: anchor,
          anchor: anchor.getBoundingClientRect(),
          observe: [anchor, ...(anchor.form ? [anchor.form] : [])],
        }
      : null;
  }, [anchorRef]);
  const placement = useFloatingMenuPlacement(
    true,
    resolveTarget,
    PICKER_CONSTRAINTS,
  );
  useModalPortal(Boolean(placement), anchorRef, menuRef);
  useSearchFocus(Boolean(placement), inputRef, menuRef);

  useEffect(() => {
    if (!placement) return;
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !anchorRef.current?.contains(target)
      )
        onClose();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("focusin", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("focusin", dismiss);
    };
  }, [anchorRef, onClose, placement]);
  const availableIndexes = useMemo(
    () =>
      results.flatMap((file, index) =>
        !disabled && !selected.includes(file.path) ? [index] : [],
      ),
    [disabled, results, selected],
  );
  const activeOption = availableIndexes.includes(activeIndex)
    ? results[activeIndex]
    : undefined;

  const moveActive = (direction: -1 | 1) => {
    if (availableIndexes.length === 0) return;
    const position = availableIndexes.indexOf(activeIndex);
    const next =
      position < 0
        ? direction === 1
          ? 0
          : availableIndexes.length - 1
        : (position + direction + availableIndexes.length) %
          availableIndexes.length;
    setActiveIndex(availableIndexes[next]!);
  };

  useEffect(() => {
    let cancelled = false;
    setResults([]);
    setTruncated(false);
    setActiveIndex(0);
    setStatus("loading");
    const timer = setTimeout(() => {
      search(query).then(
        (result) => {
          if (!cancelled) {
            setResults(rankProjectFiles(result.files, query));
            setTruncated(Boolean(result.truncated));
            setActiveIndex(0);
            setStatus("ready");
          }
        },
        () => {
          if (!cancelled) {
            setResults([]);
            setStatus("error");
          }
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, scope, search, showHidden]);

  useEffect(() => {
    if (
      availableIndexes.length > 0 &&
      !availableIndexes.includes(activeIndex)
    ) {
      setActiveIndex(availableIndexes[0]!);
    }
  }, [activeIndex, availableIndexes]);

  useEffect(() => {
    if (!keyboardActive) return;
    const option = document.getElementById(`${listId}-option-${activeIndex}`);
    if (option && listRef.current?.contains(option))
      option.scrollIntoView({ block: "nearest" });
  }, [activeIndex, keyboardActive, listId, results]);

  const navigate = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "Enter" || (event.key === "Tab" && activeOption)) {
      event.preventDefault();
      if (activeOption) onAdd(activeOption);
      return;
    }
    if (availableIndexes.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setKeyboardActive(true);
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    }
  };

  if (!placement) return null;
  return createPortal(
    <div
      ref={menuRef}
      className="picker picker--files"
      role="dialog"
      aria-label="Add project files"
      tabIndex={-1}
      data-placement={placement.direction}
      data-keyboard-active={keyboardActive}
      style={{
        left: placement.left,
        top: placement.top,
        bottom: placement.bottom,
        width: placement.width,
        maxHeight: placement.maxHeight,
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          anchorRef.current?.focus({ preventScroll: true });
        } else if (
          event.target === event.currentTarget &&
          event.key !== "Tab"
        ) {
          navigate(event);
        }
      }}
    >
      <div className="file-search-controls">
        <input
          ref={inputRef}
          className="picker__input"
          type="search"
          role="combobox"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={navigate}
          placeholder="Search project files…"
          aria-label="Search project files"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          aria-activedescendant={
            keyboardActive && activeOption
              ? `${listId}-option-${activeIndex}`
              : undefined
          }
        />
        <HiddenFilesToggle
          showHidden={showHidden}
          onChange={onShowHiddenChange}
        />
      </div>
      {truncated ? (
        <div className="picker__empty" role="status">
          Partial search results; browse the folder for more files.
        </div>
      ) : null}
      <div
        ref={listRef}
        id={listId}
        className="picker__list"
        role="listbox"
        aria-label="Project files"
        aria-busy={status === "loading"}
        onPointerMove={(event) => {
          if (event.pointerType !== "touch") setKeyboardActive(false);
        }}
      >
        {results.map((file, index) => {
          const Icon = fileIconForPath(file.path);
          const directory = parentPath(file.path);
          const matches = searchMatchRanges(
            file.path,
            query.trim().split(/\s+/),
          );
          const added = selected.includes(file.path);
          const unavailable = disabled || added;
          return (
            <button
              type="button"
              id={`${listId}-option-${index}`}
              role="option"
              aria-label={`${file.name}, ${file.path}`}
              title={file.path}
              aria-selected={added}
              disabled={unavailable}
              tabIndex={-1}
              key={file.path}
              className={`picker__row ${added ? "picker__row--added" : ""} ${keyboardActive && index === activeIndex && !unavailable ? "picker__row--active" : ""}`}
              onPointerMove={(event) => {
                if (event.pointerType !== "touch" && !unavailable)
                  setActiveIndex(index);
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onAdd(file)}
            >
              <Icon size={13} aria-hidden />
              <span className="picker__name">
                <SearchMatchText
                  text={file.name}
                  ranges={matches}
                  offset={file.path.length - file.name.length}
                />
              </span>
              {directory ? (
                <ResourcePathLabel
                  path={directory}
                  title={file.path}
                  className="picker__path"
                  matches={matches}
                />
              ) : null}
            </button>
          );
        })}
        {results.length === 0 ? (
          <div className="picker__empty" role="status">
            {status === "loading"
              ? "Searching…"
              : status === "error"
                ? "Project file search failed"
                : "No matching files"}
          </div>
        ) : null}
      </div>
    </div>,
    anchorRef.current?.closest(".overlay") ?? document.body,
  );
}
