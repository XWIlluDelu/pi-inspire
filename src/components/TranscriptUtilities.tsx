import {
  ChevronDown,
  ChevronUp,
  GalleryHorizontalEnd,
  Search,
  X,
} from "lucide-react";
import type { RefObject } from "react";
import { Dropdown } from "./Dropdown";
import {
  TRANSCRIPT_SEARCH_SCOPES,
  type TranscriptSearchScope,
  type useTranscriptSearch,
} from "./transcript-search";

export type MobileTranscriptTool = "search" | "prompt" | null;

/** Floating search and narrow launchers; Transcript retains state and focus ownership. */
export function TranscriptUtilities({
  search,
  inputRef,
  searchLauncherRef,
  promptLauncherRef,
  mobileTool,
  onOpenMobile,
  onClose,
}: {
  search: ReturnType<typeof useTranscriptSearch>;
  inputRef: RefObject<HTMLInputElement | null>;
  searchLauncherRef: RefObject<HTMLButtonElement | null>;
  promptLauncherRef: RefObject<HTMLButtonElement | null>;
  mobileTool: MobileTranscriptTool;
  onOpenMobile: (tool: MobileTranscriptTool) => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  return (
    <>
      <div className="transcript-mobile-toolbar">
        {mobileTool === null ? (
          <div
            className="transcript-mobile-toolbar__launchers"
            role="toolbar"
            aria-label="Transcript tools"
          >
            <button
              ref={promptLauncherRef}
              type="button"
              className="transcript-mobile-toolbar__button"
              aria-label="Open prompt navigation"
              title="Open prompt navigation"
              onClick={() => onOpenMobile("prompt")}
            >
              <GalleryHorizontalEnd size={18} aria-hidden />
            </button>
            <button
              ref={searchLauncherRef}
              type="button"
              className="transcript-mobile-toolbar__button"
              aria-label="Open conversation search"
              title="Search conversation"
              onClick={() => onOpenMobile("search")}
            >
              <Search size={18} aria-hidden />
            </button>
          </div>
        ) : null}
      </div>
      <div
        className={`transcript-search ${search.query ? "transcript-search--active" : ""} ${mobileTool === "search" ? "transcript-search--mobile-open" : ""}`}
        role="search"
        aria-label="Search settled transcript"
        onClick={(event) => {
          if (
            event.target === event.currentTarget ||
            (event.target instanceof Element &&
              event.target.closest(".transcript-search__icon"))
          ) {
            inputRef.current?.focus();
          }
        }}
      >
        <Search size={14} className="transcript-search__icon" aria-hidden />
        <Dropdown
          label="Search scope"
          value={search.scope}
          options={TRANSCRIPT_SEARCH_SCOPES}
          onChange={(value) => search.setScope(value as TranscriptSearchScope)}
          className="transcript-search__scope"
        />
        <input
          ref={inputRef}
          type="search"
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              search.navigate(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              const mobileSearch = mobileTool === "search";
              onClose(mobileSearch);
              if (!mobileSearch) inputRef.current?.blur();
            }
          }}
          placeholder="Search conversation"
          aria-label="Search conversation"
        />
        <output aria-live="polite" aria-label="Transcript search matches">
          {search.query
            ? search.matches.length > 0
              ? search.currentMatch >= 0
                ? `${search.currentMatch + 1} of ${search.matches.length}`
                : `${search.matches.length} ${search.matches.length === 1 ? "match" : "matches"}`
              : "No matches"
            : ""}
        </output>
        <button
          type="button"
          aria-label="Previous transcript match"
          disabled={search.matches.length === 0}
          onClick={() => search.navigate(-1)}
        >
          <ChevronUp size={13} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Next transcript match"
          disabled={search.matches.length === 0}
          onClick={() => search.navigate(1)}
        >
          <ChevronDown size={13} aria-hidden />
        </button>
        <button
          type="button"
          className="transcript-search__close"
          aria-label="Close conversation search"
          title="Close search"
          onClick={() => onClose(true)}
        >
          <X size={14} aria-hidden />
        </button>
      </div>
    </>
  );
}
