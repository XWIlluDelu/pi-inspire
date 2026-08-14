import { describe, expect, it } from "vitest";
import {
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
} from "../../shared/branch-bridge-protocol.js";

describe("branch bridge protocol framing", () => {
  it("round-trips canonical base64url JSON", () => {
    const encoded = encodeBranchBridgeJson({ v: 1, text: "λ" }, 128);
    expect(decodeBranchBridgeJson(encoded, 128)).toEqual({ v: 1, text: "λ" });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("independently enforces decoded bytes and encoded characters", () => {
    // Twelve decoded JSON bytes fit, but their sixteen base64url characters do not.
    expect(() => encodeBranchBridgeJson("1234567890", 12)).toThrow(
      /encoded character/,
    );
    const encoded = Buffer.from(JSON.stringify("1234567890"), "utf8").toString(
      "base64url",
    );
    expect(Buffer.from(encoded, "base64url")).toHaveLength(12);
    expect(() => decodeBranchBridgeJson(encoded, 12)).toThrow(/encoding/);
  });

  it("rejects non-canonical and malformed UTF-8 framing", () => {
    expect(() => decodeBranchBridgeJson("YWJj=", 32)).toThrow(/encoding/);
    expect(() =>
      decodeBranchBridgeJson(Buffer.from([0xff]).toString("base64url"), 32),
    ).toThrow();
  });
});
