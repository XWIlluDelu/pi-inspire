/** Decode an authorized, bounded file prefix without changing its raw bytes.
 * A Unicode BOM is authoritative; without one the preview retains UTF-8.
 * Streaming at a byte cap withholds an incomplete final code point rather than
 * manufacturing a replacement character for bytes that were not transferred. */
export function decodeTextPreview(
  bytes: Uint8Array,
  truncated = false,
): string {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  return new TextDecoder(encoding).decode(bytes, { stream: truncated });
}
