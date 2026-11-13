import { FolderSearch, X } from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProjectFileResult, ProjectFileSearchResult } from "../api";
import { rankProjectFiles } from "../composer-completion";
import { fileIconForPath } from "../file-icons";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { recoverableRead } from "../recovery-backoff";
import { store, useAppState } from "../store";
import {
  type FloatingMenuConstraints,
  useFloatingMenuDismissal,
  useFloatingMenuPlacement,
} from "../use-floating-menu";
import { useSearchFocus } from "../use-search-focus";
import { HiddenFilesToggle } from "./HiddenFilesToggle";
import { type ListOption, OptionList, useOptionList } from "./OptionList";
import { parentPath, ResourcePathLabel } from "./ResourcePathLabel";
import { SearchField } from "./SearchField";
import { SearchMatchText, searchMatchRanges } from "./SearchMatchText";

export function ProjectFileLabel({
  path,
  name,
  query,
  captionClass,
}: Pick<ProjectFileResult, "path" | "name"> & {
  query: string;
  captionClass: string;
}) {
  const Icon = fileIconForPath(path);
  const directory = parentPath(path);
  const matches = searchMatchRanges(path, query.trim().split(/\s+/));
  return (
    <>
      <span className="picker__file-name">
        <Icon size={13} aria-hidden />
        <span>
          <SearchMatchText
            text={name}
            ranges={matches}
            offset={path.length - name.length}
          />
        </span>
      </span>
      {directory && (
        <ResourcePathLabel
          path={directory}
          title={path}
          className={captionClass}
          matches={matches}
        />
      )}
    </>
  );
}

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

interface ProjectFilePickerProps {
  scope: string;
  showHidden: boolean;
  onShowHiddenChange: (value: boolean) => void;
  selected: readonly string[];
  disabled?: boolean;
  search: (query: string) => Promise<ProjectFileSearchResult>;
  onAdd: (file: ProjectFileResult) => void;
}

export function ProjectFileControl({
  scope,
  open,
  onOpenChange,
  disabled = false,
  buttonDisabled = disabled,
  ...picker
}: Omit<ProjectFilePickerProps, "scope"> & {
  scope: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buttonDisabled?: boolean;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`icon-button ${open ? "icon-button--active" : ""}`}
        disabled={buttonDisabled}
        onClick={() => onOpenChange(!open)}
        aria-label="Add project files"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Reference project files"
      >
        <FolderSearch size={14} aria-hidden />
      </button>
      {open && scope ? (
        <ProjectFilePicker
          {...picker}
          anchorRef={anchorRef}
          scope={scope}
          disabled={disabled}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </>
  );
}

function ProjectFilePicker({
  anchorRef,
  scope,
  showHidden,
  onShowHiddenChange,
  selected,
  disabled = false,
  search,
  onAdd,
  onClose,
}: ProjectFilePickerProps & {
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const transportGeneration = useAppState((state) => state.transportGeneration);
  const [query, setQuery] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [results, setResults] = useState<ProjectFileResult[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const list = useOptionList<ProjectFileResult>();
  const { reset } = list;
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resolveTarget = useCallback(() => {
    const anchor = anchorRef.current;
    return anchor
      ? {
          context: anchor,
          anchor: anchor.getBoundingClientRect(),
          positioningRoot: anchor.closest<HTMLElement>(".overlay"),
          observe: [anchor, ...(anchor.form ? [anchor.form] : [])],
        }
      : null;
  }, [anchorRef]);
  const placement = useFloatingMenuPlacement(
    true,
    resolveTarget,
    PICKER_CONSTRAINTS,
  );
  useSearchFocus(Boolean(placement), inputRef, menuRef);

  useFloatingMenuDismissal(Boolean(placement), anchorRef, menuRef, onClose);
  const options = useMemo(
    () =>
      results.map((file): ListOption<ProjectFileResult> => {
        const added = selected.includes(file.path);
        return {
          key: file.path,
          value: file,
          disabled: disabled || added,
          selected: added,
          title: file.path,
          label: `${file.name}, ${file.path}`,
        };
      }),
    [results, disabled, selected],
  );
  const navigate = (event: KeyboardEvent) =>
    list.navigate(event, options, onAdd, {
      wrap: true,
      tab: true,
      consumeEmptyEnter: true,
    });

  useEffect(() => {
    const request = recoverableRead(
      () => store.getState().transportGeneration === transportGeneration,
    );
    setResults([]);
    setTruncated(false);
    reset();
    setStatus("loading");
    const read = async () => {
      try {
        const result = await request.read(() => search(query));
        if (!request.current()) return;
        setResults(rankProjectFiles(result.files, query));
        setTruncated(Boolean(result.truncated));
        reset();
        setStatus("ready");
      } catch {
        if (request.current()) setStatus("error");
      }
    };
    const timer = setTimeout(() => void read(), 200);
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [query, scope, search, showHidden, transportGeneration, reset]);

  if (!placement) return null;
  return (
    <div
      ref={menuRef}
      className="picker picker--files"
      role="dialog"
      aria-label="Add project files"
      tabIndex={-1}
      data-placement={placement.direction}
      style={{
        left: placement.left,
        top: placement.top,
        bottom: placement.bottom,
        width: placement.width,
        maxHeight: placement.maxHeight,
      }}
      onKeyDown={(event) => {
        if (isComposingKeyboardEvent(event.nativeEvent)) return;
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
        <SearchField
          inputRef={inputRef}
          iconSize={13}
          role="combobox"
          value={query}
          onValueChange={setQuery}
          onKeyDown={navigate}
          placeholder="Search project files…"
          aria-label="Search project files"
          aria-autocomplete="list"
          aria-controls={list.id}
          aria-expanded="true"
          aria-activedescendant={list.descendant(options)}
        />
        <HiddenFilesToggle
          showHidden={showHidden}
          onChange={onShowHiddenChange}
        />
      </div>
      {truncated ? (
        <div className="picker__empty" role="status">
          Partial results. Browse for more files.
        </div>
      ) : null}
      <OptionList
        list={list}
        options={options}
        label="Project files"
        className="picker__list"
        loading={status === "loading"}
        onPick={onAdd}
        optionButtons
        plain
        renderOption={({ value: file }) => (
          <ProjectFileLabel
            path={file.path}
            name={file.name}
            query={query}
            captionClass="picker__path"
          />
        )}
      >
        {results.length === 0 ? (
          <div className="picker__empty" role="status">
            {status === "loading"
              ? "Searching…"
              : status === "error"
                ? "Project file search failed"
                : "No matching files"}
          </div>
        ) : null}
      </OptionList>
    </div>
  );
}
