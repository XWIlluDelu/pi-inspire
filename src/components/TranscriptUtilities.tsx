import {
  ChevronDown,
  ChevronUp,
  GalleryHorizontalEnd,
  Search,
  X,
} from "lucide-react";
import type { RefObject } from "react";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { Dropdown } from "./Dropdown";
import { SearchField } from "./SearchField";
import {
  TRANSCRIPT_SEARCH_SCOPES,
  type useTranscriptSearch,
} from "./transcript-search";

export function TranscriptUtilities({
  search,
  inputRef,
  searchLauncherRef,
  promptLauncherRef,
  onOpenPrompts,
  promptsOpen,
  searchOpen,
  onOpenSearch,
  onClose,
}: {
  search: ReturnType<typeof useTranscriptSearch>;
  inputRef: RefObject<HTMLInputElement | null>;
  searchLauncherRef: RefObject<HTMLButtonElement | null>;
  promptLauncherRef: RefObject<HTMLButtonElement | null>;
  onOpenPrompts?: () => void;
  promptsOpen: boolean;
  searchOpen: boolean;
  onOpenSearch: () => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  if (promptsOpen) return null;
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
      {onOpenPrompts && (
        <button
          ref={promptLauncherRef}
          type="button"
          className="button"
          aria-label="Prompt Map"
          title="Prompt Map"
          aria-expanded="false"
          onClick={onOpenPrompts}
        >
          <GalleryHorizontalEnd size={16} aria-hidden />
        </button>
      )}
      <button
        ref={searchLauncherRef}
        type="button"
        className="button"
        aria-label="Open conversation search"
        title="Search conversation"
        onClick={onOpenSearch}
      >
        <Search size={16} aria-hidden />
      </button>
      <section
        className="transcript-search"
        role="search"
        aria-label="Search conversation"
      >
        <SearchField
          className="transcript-search__field"
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
              <Dropdown
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
