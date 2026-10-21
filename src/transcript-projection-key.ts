export function transcriptProjectionKey(
  viewId: string | null,
  incarnation: string | null,
): string {
  return `${viewId ?? ""}\u0000${incarnation ?? ""}`;
}
