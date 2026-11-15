export const COMPOSER_HISTORY_IMAGE_REFERENCE =
  /^pi-history-image:\/\/([^/]+)\/(\d+)$/;
export const COMPOSER_HISTORY_FILE_REFERENCE =
  /^pi-history-file:\/\/([^/]+)\/(\d+)$/;

export function composerArtifactReference(
  kind: "image" | "file",
  entryId: string,
  itemIndex: number,
): string {
  return `pi-history-${kind}://${encodeURIComponent(entryId)}/${itemIndex}`;
}

export function parseComposerArtifactReference(
  kind: "image" | "file",
  reference: string,
): [entryId: string, itemIndex: number] | null {
  const pattern =
    kind === "image"
      ? COMPOSER_HISTORY_IMAGE_REFERENCE
      : COMPOSER_HISTORY_FILE_REFERENCE;
  const match = pattern.exec(reference);
  if (!match) return null;
  try {
    const entry = decodeURIComponent(match[1]!);
    const item = Number(match[2]);
    return entry &&
      encodeURIComponent(entry) === match[1] &&
      Number.isSafeInteger(item)
      ? [entry, item]
      : null;
  } catch {
    return null;
  }
}
