/** History addresses retained Pi entry identities, not compacted-context offsets.
 * Legacy coordinates remain valid for transient/mock histories only. */
export const COMPOSER_HISTORY_IMAGE_REFERENCE =
  /^(?:pi-embedded:\/\/\d+|pi-history-image:\/\/[^/]+)\/\d+$/;
export const COMPOSER_HISTORY_FILE_REFERENCE =
  /^(?:pi-file:\/\/\d+|pi-history-file:\/\/[^/]+)\/\d+$/;

export function composerArtifactReference(
  kind: "image" | "file",
  message: Record<string, unknown>,
  messageIndex: number,
  itemIndex: number,
): string {
  if (typeof message.__inspireHistoryEntryId === "string") {
    return `pi-history-${kind}://${encodeURIComponent(message.__inspireHistoryEntryId)}/${itemIndex}`;
  }
  const index = Number.isSafeInteger(message.__inspireMessageIndex)
    ? Number(message.__inspireMessageIndex)
    : messageIndex;
  return `${kind === "image" ? "pi-embedded" : "pi-file"}://${index}/${itemIndex}`;
}

export function parseComposerArtifactReference(
  kind: "image" | "file",
  reference: string,
): [entry: string | number, item: number] | null {
  const legacy = new RegExp(
    `^${kind === "image" ? "pi-embedded" : "pi-file"}://(\\d+)/(\\d+)$`,
  ).exec(reference);
  if (legacy) {
    const entry = Number(legacy[1]);
    const item = Number(legacy[2]);
    return Number.isSafeInteger(entry) && Number.isSafeInteger(item)
      ? [entry, item]
      : null;
  }
  const stable = new RegExp(`^pi-history-${kind}://([^/]+)/(\\d+)$`).exec(
    reference,
  );
  if (!stable) return null;
  try {
    const entry = decodeURIComponent(stable[1]!);
    const item = Number(stable[2]);
    return entry &&
      encodeURIComponent(entry) === stable[1] &&
      Number.isSafeInteger(item)
      ? [entry, item]
      : null;
  } catch {
    return null;
  }
}
