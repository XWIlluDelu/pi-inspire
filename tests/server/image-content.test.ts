import { describe, expect, it } from "vitest";
import {
  canonicalBase64DecodedSize,
  decodeCanonicalBase64,
  isSupportedPromptImageMimeType,
} from "../../server/image-content.js";

describe("image content", () => {
  it("accepts canonical padded or unpadded base64", () => {
    const encoded = Buffer.from("hello").toString("base64");
    expect(canonicalBase64DecodedSize(encoded)).toBe(5);
    expect(canonicalBase64DecodedSize(encoded.replace(/=+$/u, ""))).toBe(5);
    expect(decodeCanonicalBase64(encoded)?.toString()).toBe("hello");
  });

  it("rejects malformed padding, whitespace, nonzero trailing bits, and empty image data", () => {
    for (const value of ["TQ=", "TQ===", "T Q==", "TR==", "A"]) {
      expect(canonicalBase64DecodedSize(value)).toBeNull();
    }
    expect(decodeCanonicalBase64("")).toBeNull();
  });

  it("accepts only Pi prompt image media types", () => {
    expect(isSupportedPromptImageMimeType("image/png")).toBe(true);
    expect(isSupportedPromptImageMimeType("image/JPG")).toBe(true);
    expect(isSupportedPromptImageMimeType("image/svg+xml")).toBe(false);
    expect(isSupportedPromptImageMimeType("text/html")).toBe(false);
  });
});
