import { describe, expect, it } from "vitest";
import { piStartupDiagnostics } from "../../server/pi-startup-diagnostics.js";

describe("Pi startup diagnostic disclosure", () => {
  it("keeps exception bodies and unrelated stderr private while identifying actionable files", () => {
    const result = piStartupDiagnostics(
      [
        "token=private-token",
        '\x1b[31mError: Failed to load extension "/project/broken.ts": Error: private-token\x1b[0m',
        "    at private-source-code",
        "Warning: Invalid settings file C:\\Users\\fixture\\settings.json: private-settings-content",
        "Warning: Invalid settings file C:\\Users\\fixture\\settings.json: duplicate",
      ].join("\n"),
    );
    expect(result.failures).toEqual([
      'Could not load Pi extension "/project/broken.ts". Repair or disable it in Pi, then retry. Native error details are in the Host log.',
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("C:\\Users\\fixture\\settings.json");
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(piStartupDiagnostics("Unstructured private-token")).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it("bounds diagnostic count and resource paths, including colored output", () => {
    const result = piStartupDiagnostics(
      Array.from(
        { length: 20 },
        (_, index) =>
          `Error: Failed to load extension "/${"x".repeat(1000)}/${index}.ts": ignored`,
      ).join("\n"),
    );
    expect(result.failures).toHaveLength(3);
    expect(result.failures[0]).toContain("/0.ts");
    expect(result.failures.every((message) => message.length < 500)).toBe(true);
  });
});
