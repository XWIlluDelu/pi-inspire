import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { escapesBase } from "../../server/paths.js";

describe("path containment", () => {
  it("distinguishes traversal from valid names beginning with two dots", () => {
    expect(escapesBase("")).toBe(false);
    expect(escapesBase("src/file.ts")).toBe(false);
    expect(escapesBase("..notes/file.ts")).toBe(false);
    expect(escapesBase(".../file.ts")).toBe(false);
    expect(escapesBase("..")).toBe(true);
    expect(escapesBase("../secret.txt")).toBe(true);
    expect(escapesBase("..\\secret.txt")).toBe(true);
    expect(escapesBase(resolve("/tmp/secret.txt"))).toBe(true);
  });
});
