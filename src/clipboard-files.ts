/** Clipboard implementations expose the same pasted image through `files`,
 * `items`, or both. `files` is the complete primary projection when present;
 * reading `items` as well can upload one paste twice because browsers may
 * manufacture a second File with a different lastModified value. */
export function clipboardFiles(data: Pick<DataTransfer, "files" | "items"> | null | undefined): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data.items ?? []).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}
