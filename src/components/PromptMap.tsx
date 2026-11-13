import { Paperclip, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { UserTurnAnchor } from "../../shared/contracts";
import { useModalFocus } from "../use-modal-focus";

const PAGE_SIZE = 100;

export function PromptMap({
  turns,
  total,
  activeOrdinal,
  loadingStarts,
  navigatingOrdinal,
  error,
  onLoad,
  onNavigate,
  onClose,
  onSelectComplete = onClose,
}: {
  turns: readonly UserTurnAnchor[];
  total: number;
  activeOrdinal: number | null;
  loadingStarts: readonly number[];
  navigatingOrdinal: number | null;
  error: string | null;
  onLoad: (start?: number) => Promise<readonly UserTurnAnchor[]>;
  onNavigate: (ordinal: number) => Promise<boolean>;
  onClose: () => void;
  onSelectComplete?: () => void;
}) {
  const [page, setPage] = useState(() =>
    Math.floor((activeOrdinal ?? Math.max(0, total - 1)) / PAGE_SIZE),
  );
  const [pending, setPending] = useState(false);
  const live = useRef(false);
  const title = useId();
  const start = page * PAGE_SIZE;
  const ref = useModalFocus<HTMLElement>(true, title, onClose);
  useEffect(() => {
    void onLoad(start);
  }, [onLoad, start]);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const visible = turns.filter(
    ({ ordinal }) => ordinal >= start && ordinal < start + PAGE_SIZE,
  );
  const loading = loadingStarts.includes(start);
  const busy = pending || navigatingOrdinal !== null;

  const go = async (ordinal: number) => {
    setPending(true);
    try {
      if ((await onNavigate(ordinal)) && live.current) onSelectComplete();
    } finally {
      if (live.current) setPending(false);
    }
  };

  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <section
        ref={ref}
        className="dialog prompt-map"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="prompt-map__header">
          <h2 className="dialog__title" id={title}>
            User prompts
          </h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Close user prompts"
            onClick={onClose}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div
          className="prompt-map__list"
          role="list"
          aria-label="User prompts"
          aria-busy={loading || busy}
        >
          {visible.map((turn) => (
            <div key={turn.id} role="listitem">
              <button
                type="button"
                className="prompt-map__turn"
                aria-current={
                  turn.ordinal === activeOrdinal ? "location" : undefined
                }
                disabled={busy}
                onClick={() => void go(turn.ordinal)}
              >
                <span className="prompt-map__ordinal">{turn.ordinal + 1}.</span>
                <span className="prompt-map__snippet">{turn.snippet}</span>
                {turn.attachmentCount > 0 && (
                  <span className="prompt-map__attachments">
                    <Paperclip size={12} aria-hidden />
                    <span aria-hidden="true">{turn.attachmentCount}</span>
                    <span className="visually-hidden">
                      {turn.attachmentCount}{" "}
                      {turn.attachmentCount === 1
                        ? "attachment"
                        : "attachments"}
                    </span>
                  </span>
                )}
              </button>
            </div>
          ))}
        </div>
        {error ? (
          <p role="alert">
            {error}{" "}
            <button type="button" onClick={() => void onLoad(start)}>
              Retry
            </button>
          </p>
        ) : loading ? (
          <p role="status">Loading user prompts…</p>
        ) : total === 0 ? (
          <p>No user prompts</p>
        ) : null}
        {total > PAGE_SIZE && (
          <footer className="dialog__actions">
            <button
              type="button"
              className="button button--quiet"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Earlier prompts
            </button>
            <span>
              {start + 1}–{Math.min(start + PAGE_SIZE, total)} of {total}
            </span>
            <button
              type="button"
              className="button button--quiet"
              disabled={start + PAGE_SIZE >= total}
              onClick={() => setPage(page + 1)}
            >
              Later prompts
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}
