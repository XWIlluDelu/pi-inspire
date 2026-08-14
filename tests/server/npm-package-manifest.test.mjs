import { describe, expect, it } from "vitest";
import {
  npmPackageRecord,
  parseNpmJsonOutput,
} from "../../scripts/npm-package-manifest.mjs";

const record = {
  id: "inspire-pi-gui@0.1.0",
  filename: "inspire-pi-gui-0.1.0.tgz",
};

describe("npm package manifest compatibility", () => {
  it.each([
    ["array", [record]],
    ["direct object", record],
    ["package-name keyed object", { "inspire-pi-gui": record }],
  ])("accepts npm's %s record shape", (_name, manifest) => {
    expect(npmPackageRecord(manifest)).toEqual(record);
  });

  it("parses a trailing JSON record after lifecycle output", () => {
    expect(
      parseNpmJsonOutput(`vite v7.3.0 building\n${JSON.stringify(record)}`),
    ).toEqual(record);
  });

  it("rejects JSON that does not contain a package record", () => {
    expect(() => npmPackageRecord({ package: {} })).toThrow(
      "did not report a package record",
    );
  });
});
