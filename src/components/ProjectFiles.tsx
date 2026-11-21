import { FolderSearch, X } from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProjectFileResult, ProjectFileSearchResult } from "../api";
import { rankProjectFiles } from "../composer-completion";
import { fileIconForPath } from "../file-icons";
import { recoverableRead } from "../recovery-backoff";
import { store, useAppState } from "../store";
import type { FloatingMenuConstraints } from "../use-floating-menu";
import { AnchoredPanel } from "./ChoicePanel";
import { HiddenFilesToggle } from "./HiddenFilesToggle";
import { type ListOption, OptionList, useOptionList } from "./OptionList";
import { parentPath, ResourcePathLabel } from "./ResourcePathLabel";
import { SearchField } from "./SearchField";
import { SearchMatchText, searchMatchRanges } from "./SearchMatchText";

export function ProjectFileLabel({
  path,
  name,
  query,
}: Pick<ProjectFileResult, "path" | "name"> & {
  query: string;
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
          className="picker__path"
          matches={matches}
        />
      )}
    </>
  );
}

export function projectFileOption(file: ProjectFileResult) {
  return {
    key: file.path,
    value: file,
    title: file.path,
    label: `${file.name}, ${file.path}`,
  };
}

export function ProjectFileFeedback({
  empty,
  status,
  truncated,
  partialText = "Partial search results",
  emptyText = "No matching files",
  loadingText = "Searching…",
}: {
  empty: boolean;
  status: "loading" | "ready" | "error";
  truncated: boolean;
  partialText?: string;
  emptyText?: string;
  loadingText?: string;
}) {
  const message = truncated
    ? partialText
    : !empty
      ? null
      : status === "loading"
        ? loadingText
        : status === "error"
          ? "Project file search failed"
          : emptyText;
  return (
    message && (
      <div
        className="picker__empty"
        data-error={status === "error"}
        role="status"
      >
        {message}
      </div>
    )
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

export type ProjectFileSearch = (
  query: string,
  signal: AbortSignal,
) => Promise<ProjectFileSearchResult>;

interface ProjectFilePickerProps {
  scope: string;
  showHidden: boolean;
  onShowHiddenChange: (value: boolean) => void;
  selected: readonly string[];
  disabled?: boolean;
  search: ProjectFileSearch;
  onAdd: (file: ProjectFileResult) => void;
}

export function useProjectFileSearch(
  search: ProjectFileSearch | undefined,
  query: string | undefined,
  scope: string | null | undefined,
  showHidden: boolean,
  delay: number,
) {
  const transport = useAppState((state) => state.transportGeneration);
  const owner = useMemo(
    () => ({ query, search, scope, showHidden, transport }),
    [query, search, scope, showHidden, transport],
  );
  const [response, setResponse] = useState<{
    owner: typeof owner;
    result: ProjectFileSearchResult | null;
  }>();
  useEffect(() => {
    const { query, search, transport } = owner;
    if (query === undefined || !search) return;
    const request = recoverableRead(
      () => store.getState().transportGeneration === transport,
    );
    const publish = (result: ProjectFileSearchResult | null) => {
      if (request.current()) setResponse({ owner, result });
    };
    const timer = setTimeout(() => {
      void request
        .read((signal) => search(query, signal))
        .then(
          (result) =>
            publish({
              ...result,
              files: rankProjectFiles(result.files, query),
            }),
          () => publish(null),
        );
    }, delay);
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [owner, delay]);

  const current = response?.owner === owner ? response.result : undefined;
  const status: "loading" | "ready" | "error" =
    current === null
      ? "error"
      : current || query === undefined
        ? "ready"
        : "loading";
  return {
    files: current?.files ?? EMPTY_FILES,
    truncated: Boolean(current?.truncated),
    status,
  };
}

const EMPTY_FILES: readonly ProjectFileResult[] = [];

export function ProjectFileControl({
  scope,
  disabled = false,
  buttonDisabled = disabled,
  ...picker
}: Omit<ProjectFilePickerProps, "scope"> & {
  scope: string | null;
  buttonDisabled?: boolean;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`icon-button ${open ? "icon-button--active" : ""}`}
        disabled={buttonDisabled}
        onClick={() => setOpen(!open)}
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
          onClose={() => setOpen(false)}
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
  const [query, setQuery] = useState("");
  const {
    files: results,
    truncated,
    status,
  } = useProjectFileSearch(search, query, scope, showHidden, 200);
  const list = useOptionList<ProjectFileResult>();
  const { reset } = list;
  const options = useMemo(
    () =>
      results.map((file): ListOption<ProjectFileResult> => {
        const added = selected.includes(file.path);
        return {
          ...projectFileOption(file),
          disabled: disabled || added,
          selected: added,
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

  useEffect(() => reset(), [results, reset]);

  return (
    <AnchoredPanel
      open
      label="Add project files"
      anchorRef={anchorRef}
      constraints={PICKER_CONSTRAINTS}
      searchable
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && event.key !== "Tab")
          navigate(event);
      }}
    >
      <div className="file-search-controls">
        <SearchField
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
          <ProjectFileLabel path={file.path} name={file.name} query={query} />
        )}
      >
        <ProjectFileFeedback
          status={status}
          empty={!options.length}
          truncated={truncated}
          partialText="Partial results. Browse for more files."
        />
      </OptionList>
    </AnchoredPanel>
  );
}
