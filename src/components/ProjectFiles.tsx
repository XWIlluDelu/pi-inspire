import { FolderSearch, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ProjectFileResult } from "../api";
import { rankProjectFiles } from "../composer-completion";

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
          <span className="attachment__name">{path}</span>
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

export function ProjectFilePicker({
  scope,
  selected,
  disabled = false,
  search,
  onAdd,
  onClose,
}: {
  scope: string;
  selected: readonly string[];
  disabled?: boolean;
  search: (query: string) => Promise<ProjectFileResult[]>;
  onAdd: (file: ProjectFileResult) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProjectFileResult[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
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
    setActiveIndex(0);
    setStatus("loading");
    const timer = setTimeout(() => {
      search(query).then(
        (files) => {
          if (!cancelled) {
            setResults(rankProjectFiles(files, query));
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
  }, [query, scope, search]);

  useEffect(() => {
    if (
      availableIndexes.length > 0 &&
      !availableIndexes.includes(activeIndex)
    ) {
      setActiveIndex(availableIndexes[0]!);
    }
  }, [activeIndex, availableIndexes]);

  useEffect(() => {
    const option = document.getElementById(`${listId}-option-${activeIndex}`);
    if (option && listRef.current?.contains(option))
      option.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId, results]);

  return (
    <div className="picker" role="dialog" aria-label="Add project files">
      <input
        className="picker__input"
        type="search"
        role="combobox"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key === "Enter" || (event.key === "Tab" && activeOption)) {
            event.preventDefault();
            if (activeOption) onAdd(activeOption);
            return;
          }
          if (availableIndexes.length === 0) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveActive(event.key === "ArrowDown" ? 1 : -1);
            return;
          }
        }}
        placeholder="Search project files…"
        aria-label="Search project files"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded="true"
        aria-activedescendant={
          activeOption ? `${listId}-option-${activeIndex}` : undefined
        }
        autoFocus
      />
      <div
        ref={listRef}
        id={listId}
        className="picker__list"
        role="listbox"
        aria-label="Project files"
        aria-busy={status === "loading"}
      >
        {results.map((file, index) => {
          const added = selected.includes(file.path);
          const unavailable = disabled || added;
          return (
            <button
              type="button"
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={added}
              disabled={unavailable}
              tabIndex={-1}
              key={file.path}
              className={`picker__row ${added ? "picker__row--added" : ""} ${index === activeIndex && !unavailable ? "picker__row--active" : ""}`}
              onMouseMove={() => {
                if (!unavailable) setActiveIndex(index);
              }}
              onClick={() => onAdd(file)}
            >
              <span className="picker__name">{file.name}</span>
              <span className="picker__path">{file.path}</span>
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
    </div>
  );
}
