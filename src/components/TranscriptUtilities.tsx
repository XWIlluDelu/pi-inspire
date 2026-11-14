import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { RefObject } from "react";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { NativeSelect } from "./NativeSelect";
import { SearchField } from "./SearchField";
import {
  TRANSCRIPT_SEARCH_SCOPES,
  type useTranscriptSearch,
} from "./transcript-search";

export function TranscriptUtilities({
  search,
  inputRef,
  searchLauncherRef,
  onOpenHistory,
  searchOpen,
  onOpenSearch,
  onClose,
}: {
  search: ReturnType<typeof useTranscriptSearch>;
  inputRef: RefObject<HTMLInputElement | null>;
  searchLauncherRef: RefObject<HTMLButtonElement | null>;
  onOpenHistory?: () => void;
  searchOpen: boolean;
  onOpenSearch: () => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const matchCount = search.matches.length;
  const currentMatch = Math.min(search.currentMatch + 1, matchCount);
  const matchStatus = currentMatch
    ? `${currentMatch} of ${matchCount}`
    : `${matchCount} ${matchCount === 1 ? "match" : "matches"}`;

  return (
    <div
      className="transcript-tools"
      data-search-open={searchOpen || undefined}
      role="toolbar"
      aria-label="Transcript tools"
    >
      {onOpenHistory && (
        <button
          type="button"
          className="button transcript-tools__history"
          onClick={onOpenHistory}
        >
          Turn history
        </button>
      )}
      <button
        ref={searchLauncherRef}
        type="button"
        className="button transcript-tools__open"
        aria-label="Open conversation search"
        title="Search conversation"
        onClick={onOpenSearch}
      >
        <Search size={18} aria-hidden />
      </button>
      <section
        className="transcript-search"
        role="search"
        aria-label="Search conversation"
      >
        <SearchField
          className="transcript-search__field"
          data-query-active={Boolean(search.query) || undefined}
          inputRef={inputRef}
          value={search.query}
          onValueChange={search.setQuery}
          onKeyDown={(event) => {
            if (isComposingKeyboardEvent(event.nativeEvent)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              search.navigate(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (searchOpen) onClose(true);
              else inputRef.current?.blur();
            }
          }}
          placeholder="Search conversation"
          aria-label="Search conversation"
          title="Search loaded conversation messages"
          action={
            <>
              <NativeSelect
                label="Search scope"
                value={search.scope}
                options={TRANSCRIPT_SEARCH_SCOPES}
                onChange={search.setScope}
                className="transcript-search__scope"
              />
              <output
                className="sr-only"
                aria-live="polite"
                aria-label="Transcript search matches"
              >
                {search.query ? matchStatus : ""}
              </output>
              {search.query ? (
                <span
                  className="transcript-search__count"
                  aria-hidden="true"
                  title={matchStatus}
                >
                  {currentMatch ? `${currentMatch}/${matchCount}` : matchCount}
                </span>
              ) : null}
              <button
                className="icon-button"
                type="button"
                aria-label="Previous transcript match"
                disabled={matchCount === 0}
                onClick={() => search.navigate(-1)}
              >
                <ChevronUp size={13} aria-hidden />
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Next transcript match"
                disabled={matchCount === 0}
                onClick={() => search.navigate(1)}
              >
                <ChevronDown size={13} aria-hidden />
              </button>
              <button
                type="button"
                className="icon-button transcript-tools__close"
                aria-label="Close conversation search"
                title="Close search"
                onClick={() => onClose(true)}
              >
                <X size={14} aria-hidden />
              </button>
            </>
          }
        />
      </section>
    </div>
  );
}
