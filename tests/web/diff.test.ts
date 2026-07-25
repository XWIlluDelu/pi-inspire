import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/diff";

const PATCH = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,4 @@",
  " import x from \"x\";",
  "-const a = 1;",
  "+const a = 2;",
  " export default a;",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("parses a unified diff into typed lines", () => {
    const lines = parseUnifiedDiff(PATCH);
    expect(lines).not.toBeNull();
    expect(lines!.map((line) => line.type)).toEqual([
      "meta",
      "meta",
      "hunk",
      "context",
      "del",
      "add",
      "context",
    ]);
  });

  it("keeps tool preamble before the diff as meta", () => {
    const lines = parseUnifiedDiff(`Edited src/app.ts:\n${PATCH}`);
    expect(lines?.[0]).toEqual({ type: "meta", text: "Edited src/app.ts:" });
    expect(lines?.some((line) => line.type === "add")).toBe(true);
  });

  it("rejects prose whose lines merely start with + or -", () => {
    expect(parseUnifiedDiff("- bullet one\n- bullet two\n+ emphasis")).toBeNull();
    expect(parseUnifiedDiff("email @@ mentions --- +++ but no hunk header")).toBeNull();
  });

  it("rejects hunk-shaped text without file markers", () => {
    expect(parseUnifiedDiff("@@ -1,2 +1,2 @@\n-a\n+b")).toBeNull();
  });
});
