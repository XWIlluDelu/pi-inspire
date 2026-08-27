import { Buffer } from "node:buffer";

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function isBase64Character(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  );
}

export function isSupportedPromptImageMimeType(value: string): boolean {
  return /^image\/(?:png|jpe?g|gif|webp)$/iu.test(value);
}

/** Validate standard canonical base64 (padding may be omitted) without
 * allocating the decoded body. */
export function canonicalBase64DecodedSize(value: string): number | null {
  if (!value) return null;
  let unpaddedLength = value.length;
  while (unpaddedLength > 0 && value.charCodeAt(unpaddedLength - 1) === 0x3d)
    unpaddedLength -= 1;
  const padding = value.length - unpaddedLength;
  if (unpaddedLength === 0 || padding > 2) return null;
  for (let index = 0; index < unpaddedLength; index += 1) {
    if (!isBase64Character(value.charCodeAt(index))) return null;
  }

  const remainder = unpaddedLength % 4;
  if (
    remainder === 1 ||
    (padding > 0 &&
      !(
        (remainder === 2 && padding === 2) ||
        (remainder === 3 && padding === 1)
      ))
  )
    return null;

  const tail = BASE64_ALPHABET.indexOf(value[unpaddedLength - 1]!);
  if (
    tail < 0 ||
    (remainder === 2 && (tail & 0x0f) !== 0) ||
    (remainder === 3 && (tail & 0x03) !== 0)
  )
    return null;
  return Math.floor((unpaddedLength * 6) / 8);
}

export function decodeCanonicalBase64(value: string): Buffer | null {
  const size = canonicalBase64DecodedSize(value);
  return size === null || size === 0 ? null : Buffer.from(value, "base64");
}
