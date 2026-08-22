import { createContext, type ReactNode, useContext } from "react";

const VisibleActivityItems = createContext<ReadonlySet<string> | null>(null);

export function ActivityItemVisibilityProvider({
  visibleIds,
  children,
}: {
  visibleIds: ReadonlySet<string> | null;
  children: ReactNode;
}) {
  return (
    <VisibleActivityItems.Provider value={visibleIds}>
      {children}
    </VisibleActivityItems.Provider>
  );
}

export function useVisibleActivityItemIds(): ReadonlySet<string> | null {
  return useContext(VisibleActivityItems);
}

function useActivityItemVisible(id: string): boolean {
  const visibleIds = useVisibleActivityItemIds();
  return visibleIds === null || visibleIds.has(id);
}

function isVisible(
  visibleIds: ReadonlySet<string> | null,
  ids: readonly string[],
): boolean {
  return (
    visibleIds === null ||
    ids.length === 0 ||
    ids.some((id) => visibleIds.has(id))
  );
}

/** Keeps an all-omitted projection fragment mounted without leaving its round
 * marker or structural spacing behind. */
export function ActivitySegmentBoundary({
  ids,
  children,
}: {
  ids: readonly string[];
  children: ReactNode;
}) {
  const visibleIds = useVisibleActivityItemIds();
  return (
    <div
      className="activity-item-boundary"
      hidden={!isVisible(visibleIds, ids)}
    >
      {children}
    </div>
  );
}

/** Keeps omitted activity mounted so disclosure state survives Compact →
 * Expanded, while display: contents leaves the established card geometry
 * untouched. */
export function ActivityItemBoundary({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const visible = useActivityItemVisible(id);
  return (
    <div className="activity-item-boundary" hidden={!visible}>
      {children}
    </div>
  );
}
