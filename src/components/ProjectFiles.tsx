import { FolderSearch, X } from "lucide-react";
import { useEffect, useState } from "react";
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
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setResults([]);
    setStatus("loading");
    const timer = setTimeout(() => {
      search(query).then(
        (files) => {
          if (!cancelled) {
            setResults(rankProjectFiles(files, query));
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

  return (
    <div className="picker" role="dialog" aria-label="Add project files">
      <input
        className="picker__input"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        placeholder="Search project files…"
        aria-label="Search project files"
        autoFocus
      />
      <div className="picker__list" role="listbox" aria-label="Project files" aria-busy={status === "loading"}>
        {results.map((file) => {
          const added = selected.includes(file.path);
          return (
            <button
              type="button"
              role="option"
              aria-selected={added}
              disabled={disabled}
              key={file.path}
              className={`picker__row ${added ? "picker__row--added" : ""}`}
              onClick={() => onAdd(file)}
            >
              <span className="picker__name">{file.name}</span>
              <span className="picker__path">{file.path}</span>
            </button>
          );
        })}
        {results.length === 0 ? (
          <div className="picker__empty" role="status">
            {status === "loading" ? "Searching…" : status === "error" ? "Project file search failed" : "No matching files"}
          </div>
        ) : null}
      </div>
    </div>
  );
}
