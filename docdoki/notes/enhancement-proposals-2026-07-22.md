---
purpose: Remaining optional post-MVP enhancements from the 2026-07-22 review after completed proposals were promoted into current specs and implementation.
---

# Enhancement proposals

The original review also proposed per-session drafts and bounded attachment
lifecycle; both now belong to the implemented composer and host contracts, so
they no longer remain in this optional backlog. The proposals below are still
unselected unless a current stage explicitly adopts them.

## Session list pagination

The server supports `offset`, `limit`, and `total`, while ordinary navigation
still starts from the latest 40 sessions. Add incremental loading when daily
use requires browsing old, unpinned history without search. Pinned and hidden
identities may continue to hydrate directly outside that first page.

## Transcript search

Provide client-side find over settled message text with jump-to-match in the
virtualized transcript. Keep Pi JSONL authoritative; no durable browser index
is required for the first slice.

## Composer file completion

Add inline `@` completion by reusing the existing project index and a bounded,
explainable scoring order. Quoted paths and directory drill-down should extend
the current project-file picker rather than create a second file authority.

## Composer command completion

Surface Pi extension commands and inspire built-ins after `/`, grouped by
source. Keep visible controls as the discoverable path; completion accelerates
the same operations rather than hiding them behind command syntax.

## Conversation minimap and forks

Evolve the transcript scroll rail so hover can reveal message-position ticks,
bookmarks, and branch points without adding a permanent minimap column. Pair
that projection with supported session fork, edit-from-here, and branch-switch
operations once their Pi runtime contract is implemented.

## Streaming resilience

Consider periodic authoritative reconciliation, late-event rejection, and
per-frame delta coalescing only when a reproduced event-loss or throughput
problem justifies the extra runtime behavior. Existing snapshot ordering and
keyed-message safeguards remain the baseline.

## Session branch tree

Use the contextual pane to show active-session ancestry and children, then add
supported fork and branch-switch operations when the runtime contract is ready.
[[session-continuity]] reserves branch-tree navigation for a later release; the
transcript-side projection of the same material is the minimap direction above.

## Proactive mention verification

The files pane marks a reference unavailable only after a resolve fails, so a
stale textual mention still reads as an ordinary file until it is first opened.
A bounded host batch could check the visible projection's mentions when a
session opens and mark them up front. It costs a round trip per session and a
host endpoint that answers existence without opening content, so take it only
if first-click surprise proves to be a real irritation — the resolver already
tells the truth on demand, and the mark clears itself when a reference resolves
again.

## Background completion notification

When a hidden tab receives `agent_settled`, optionally emit a permission-gated
desktop notification or title marker. This should be an explicit preference,
not an unconditional browser prompt.

## Git changes surface

A right-pane Changes surface could show branch identity, changed files, status,
and bounded per-file diffs. This is deliberately deferred: the user has not yet
settled whether the panel is primarily for review, staging, committing, or a
broader repository workflow. Read-only status/diff should precede mutations when
the product purpose is chosen.

## Generic extension widget fallback

Render unsupported widget/status text through a generic lossless surface rather
than dropping it. The fallback must remain attributable to its extension and
must not create extension-specific runtime behavior.

## Model picker quality

Group models by provider and consider recent selections when the available-model
list becomes unwieldy. Keep model capability facts sourced from Pi rather than a
browser-maintained catalog.

## In-transcript queue visibility

Render queued steering and follow-up text as distinguishable pending bubbles,
with cancellation only if the host exposes an ordered, addressable queue
operation.
