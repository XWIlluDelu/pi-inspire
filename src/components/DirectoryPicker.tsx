import { CornerLeftUp, Folder, HardDrive, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { HostDirEntry, HostDirListing } from "../../shared/contracts";
import { store } from "../store";
import { useModalFocus } from "../use-modal-focus";

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
  const [roots, setRoots] = useState<HostDirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const dialogRef = useModalFocus<HTMLDivElement>();
  // Only the newest request may write state — rapid navigation must not
  // let a slow earlier level overwrite a later one.
  const ticket = useRef(0);

  const load = (
    path?: string,
    { fallbackHome = false, discoverRoots = false }: { fallbackHome?: boolean; discoverRoots?: boolean } = {},
  ) => {
    const mine = ++ticket.current;
    setLoading(true);
    setError(null);
    const listing = store.browseHostDirs(path).catch((cause: unknown) => {
      if (fallbackHome && path) return store.browseHostDirs();
      throw cause;
    });
    const availableRoots = discoverRoots ? store.browseHostRoots() : Promise.resolve(null);
    void Promise.all([listing, availableRoots])
      .then(([result, rootResult]) => {
        if (ticket.current !== mine) return;
        setListing(result);
        if (rootResult) setRoots(rootResult.roots);
      })
      .catch((cause: unknown) => {
        if (ticket.current === mine) setError(cause instanceof Error ? cause.message : "Cannot open that directory");
      })
      .finally(() => {
        if (ticket.current === mine) setLoading(false);
      });
  };

  useEffect(() => {
    load(initial?.trim() || undefined, { fallbackHome: true, discoverRoots: true });
    // mount only: the picker owns navigation after the first level
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes the picker before the global handlers can see it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

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
        <h2 className="dialog__title">Choose project directory</h2>
        <div className="dirpicker__path">{listing?.path ?? "…"}</div>
        {roots.length > 1 ? (
          <div className="dirpicker__roots" role="group" aria-label="Filesystem roots">
            {roots.map((root) => (
              <button
                key={root.path}
                type="button"
                className="dirpicker__root"
                title={`Browse ${root.path}`}
                onClick={() => load(root.path)}
              >
                <HardDrive size={13} aria-hidden />
                <span>{root.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="dirpicker__list">
          {listing?.parent ? (
            <button type="button" className="dirpicker__row" onClick={() => load(listing.parent ?? undefined)}>
              <CornerLeftUp size={13} aria-hidden />
              <span className="dirpicker__name">..</span>
            </button>
          ) : null}
          {listing?.dirs.map((entry) => (
            <button key={entry.path} type="button" className="dirpicker__row" onClick={() => load(entry.path)}>
              <Folder size={13} aria-hidden />
              <span className="dirpicker__name">{entry.name}</span>
            </button>
          ))}
          {loading ? (
            <div className="dirpicker__note">
              <Loader2 size={12} className="spin" aria-hidden /> Loading…
            </div>
          ) : error ? (
            <div className="dirpicker__note dirpicker__note--error" role="alert">
              {error}
            </div>
          ) : listing && listing.dirs.length === 0 ? (
            <div className="dirpicker__note">No subdirectories</div>
          ) : null}
        </div>
        <div className="dialog__actions">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!listing}
            onClick={() => listing && onPick(listing.path)}
          >
            Use this directory
          </button>
        </div>
      </div>
    </div>
  );
}
