const DIMENSION_NOTE = String.raw`\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+\.\d{2} to map to original image\.\]`;
const DIMENSION_NOTE_SUFFIX = new RegExp(
  String.raw`(?:\r?\n){2}${DIMENSION_NOTE}(?:\r?\n${DIMENSION_NOTE})*$`,
);

/** Pi appends these model-facing hints to image prompts. Keep the stored source
 * intact; only omit the exact appended suffix from reading/editing projections. */
export function stripImageDimensionNotes(
  text: string,
  imageCount: number,
): string {
  return imageCount > 0 ? text.replace(DIMENSION_NOTE_SUFFIX, "") : text;
}
