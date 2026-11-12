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
  ])("extracts npm's %s record after lifecycle output", (_name, manifest) => {
    const output = `building release assets\n${JSON.stringify(manifest)}\n`;
    expect(npmPackageRecord(parseNpmJsonOutput(output))).toEqual(record);
  });

  it("rejects JSON that does not contain a package record", () => {
    expect(() => npmPackageRecord({ package: {} })).toThrow(
      "did not report a package record",
    );
  });
});
