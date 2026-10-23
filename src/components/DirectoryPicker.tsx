import { CornerLeftUp, Eye, EyeOff, Folder, HardDrive } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HostDirEntry, HostDirListing } from "../../shared/contracts";
import { ApiError } from "../api";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { isTransientFailure, RecoveryBackoff } from "../recovery-backoff";
import { store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { PiLoader } from "./PiLoader";

/**
 * Host-side directory browser for the session-start surface. The host
 * process lists its own filesystem, so over SSH forwards or remote
 * deployments the tree is always the machine sessions run on, and entry
 * paths arrive pre-joined with the host's own separators.
 */
export function DirectoryPicker({
  initial,
  onCancel,
  onPick,
}: {
  /** Starting directory; a bad or relative value falls back to the host home. */
  initial?: string;
  onCancel: () => void;
  onPick: (path: string) => void;
}) {
  const [listing, setListing] = useState<HostDirListing | null>(null);
  const [path, setPath] = useState(initial?.trim() ?? "");
  const [roots, setRoots] = useState<HostDirEntry[]>([]);
  const [rootsUnavailable, setRootsUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const transportGeneration = useAppState((state) => state.transportGeneration);
  const initialTransport = useRef(transportGeneration);
  const pathRef = useRef(path);
  pathRef.current = path;
  const listingTransport = useRef<number | null>(null);
  const listingRequest = useRef<AbortController | null>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(
    true,
    "directory-picker",
    onCancel,
  );
  // Only the newest request may write state — rapid navigation must not
  // let a slow earlier level overwrite a later one.
  const ticket = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreListFocus = useRef(false);
  useLayoutEffect(() => {
    if (loading || !restoreListFocus.current) return;
    restoreListFocus.current = false;
    // Do not steal focus if the user moved elsewhere while the request ran.
    if (
      document.activeElement !== document.body &&
      document.activeElement !== listRef.current
    )
      return;
    (
      listRef.current?.querySelector<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? listRef.current
    )?.focus({ preventScroll: true });
  }, [loading]);
  const requested = useRef<{
    path?: string;
    fallbackHome?: boolean;
  }>({});

  const load = (
    path?: string,
    {
      fallbackHome = false,
      hidden = showHidden,
    }: {
      fallbackHome?: boolean;
      hidden?: boolean;
    } = {},
  ) => {
    const mine = ++ticket.current;
    listingRequest.current?.abort();
    const request = new AbortController();
    const recovery = new RecoveryBackoff();
    listingRequest.current = request;
    const owns = () =>
      !request.signal.aborted &&
      ticket.current === mine &&
      store.getState().transportGeneration === transportGeneration;
    requested.current = { path, fallbackHome };
    restoreListFocus.current = Boolean(
      listRef.current?.contains(document.activeElement),
    );
    setPath(path ?? "");
    if (
      listing?.path !== path ||
      hidden !== showHidden ||
      listingTransport.current !== transportGeneration
    )
      setListing(null);
    setLoading(true);
    setError(null);
    const read = async (
      target?: string,
    ): Promise<HostDirListing | undefined> => {
      while (owns()) {
        try {
          return await store.browseHostDirs(target, hidden);
        } catch (cause) {
          if (!owns()) return undefined;
          if (
            !isTransientFailure(cause) ||
            !(await recovery.wait(request.signal))
          )
            throw cause;
        }
      }
      return undefined;
    };
    return read(path)
      .catch((cause: unknown) => {
        if (!owns()) return undefined;
        if (
          fallbackHome &&
          path &&
          cause instanceof ApiError &&
          [400, 403, 404].includes(cause.status)
        ) {
          recovery.reset();
          return read(undefined);
        }
        throw cause;
      })
      .then((result) => {
        if (!owns() || !result) return;
        requested.current = { path: result.path };
        listingTransport.current = transportGeneration;
        setListing(result);
        setPath(result.path);
        return result;
      })
      .catch((cause: unknown) => {
        if (!owns()) return;
        if (!isTransientFailure(cause)) {
          setListing(null);
          listingTransport.current = null;
        }
        setError(
          cause instanceof Error ? cause.message : "Cannot open that directory",
        );
      })
      .finally(() => {
        recovery.reset();
        if (owns()) setLoading(false);
        if (listingRequest.current === request) listingRequest.current = null;
      });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: transport replacement revalidates the live path; navigation and visibility own their own reads.
  useEffect(() => {
    const request = new AbortController();
    const recovery = new RecoveryBackoff();
    const owns = () =>
      !request.signal.aborted &&
      store.getState().transportGeneration === transportGeneration;
    void load(pathRef.current.trim() || undefined, {
      fallbackHome: initialTransport.current === transportGeneration,
    });
    setRoots([]);
    setRootsUnavailable(false);
    // Advisory drive discovery must not block directory navigation.
    void (async () => {
      try {
        while (owns()) {
          try {
            const result = await store.browseHostRoots();
            if (owns()) setRoots(result.roots);
            return;
          } catch (cause) {
            if (!owns()) return;
            if (
              !isTransientFailure(cause) ||
              !(await recovery.wait(request.signal))
            )
              throw cause;
          }
        }
      } catch {
        if (owns()) setRootsUnavailable(true);
      } finally {
        recovery.reset();
      }
    })();
    return () => {
      request.abort();
      recovery.reset();
      listingRequest.current?.abort();
      ticket.current += 1;
    };
  }, [transportGeneration]);

  return (
    <div className="overlay" role="presentation" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="dialog dirpicker"
        role="dialog"
        aria-modal="true"
        aria-label="Choose project directory"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dirpicker__header">
          <h2 className="dialog__title">Choose project directory</h2>
          <button
            type="button"
            className="icon-button dirpicker__hidden"
            aria-label="Show hidden folders"
            aria-pressed={showHidden}
            title={showHidden ? "Hide hidden folders" : "Show hidden folders"}
            onClick={() => {
              const hidden = !showHidden;
              setShowHidden(hidden);
              const { path, ...options } = requested.current;
              void load(path, { ...options, hidden });
            }}
          >
            {showHidden ? (
              <Eye size={16} aria-hidden />
            ) : (
              <EyeOff size={16} aria-hidden />
            )}
          </button>
        </div>
        <div className="dirpicker__path-field" data-path={path}>
          <textarea
            rows={1}
            className="dirpicker__path"
            aria-label="Project directory"
            value={path}
            placeholder="/path/to/project"
            spellCheck={false}
            readOnly={loading}
            aria-busy={loading}
            onChange={(event) => {
              setPath(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !isComposingKeyboardEvent(event.nativeEvent)
              ) {
                event.preventDefault();
                if (path.trim() && !loading) void load(path.trim());
              }
            }}
          />
        </div>
        {rootsUnavailable ? (
          <div className="dirpicker__note" role="status">
            Drive list unavailable. Enter a full path to browse another
            location.
          </div>
        ) : null}
        {roots.length > 1 ? (
          <div
            className="dirpicker__roots"
            role="group"
            aria-label="Filesystem roots"
          >
            {roots.map((root) => (
              <button
                key={root.path}
                type="button"
                className="dirpicker__root button--quiet"
                title={`Browse ${root.path}`}
                onClick={() => void load(root.path)}
              >
                <HardDrive size={13} aria-hidden />
                <span>{root.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div
          ref={listRef}
          className="dirpicker__list"
          role="group"
          aria-label="Folders"
          tabIndex={-1}
          aria-busy={loading}
        >
          {listing?.parent ? (
            <button
              type="button"
              className="dirpicker__row"
              disabled={loading}
              onClick={() => void load(listing.parent ?? undefined)}
            >
              <CornerLeftUp size={13} aria-hidden />
              <span className="dirpicker__name">..</span>
            </button>
          ) : null}
          {listing?.dirs.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="dirpicker__row"
              disabled={loading}
              onClick={() => void load(entry.path)}
            >
              <Folder size={13} aria-hidden />
              <span className="dirpicker__name">{entry.name}</span>
            </button>
          ))}
          {loading ? (
            <div className="dirpicker__note" role="status">
              <PiLoader size={12} aria-hidden /> Loading…
            </div>
          ) : error ? (
            <div
              className="dirpicker__note dirpicker__note--error"
              role="alert"
            >
              {error}
            </div>
          ) : listing && listing.dirs.length === 0 ? (
            <div className="dirpicker__note">No subdirectories</div>
          ) : null}
        </div>
        <div className="dialog__actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!path.trim() || loading || !!error}
            onClick={() => {
              if (listing && path.trim() === listing.path) onPick(listing.path);
              else
                void load(path.trim()).then((result) => {
                  if (result) onPick(result.path);
                });
            }}
          >
            Use this directory
          </button>
        </div>
      </div>
    </div>
  );
}
