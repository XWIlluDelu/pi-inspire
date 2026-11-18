import { describe, expect, it } from "vitest";
import { npmPackageRecord } from "../../scripts/npm-package-manifest.mjs";

const record = {
  id: "inspire-pi-gui@0.1.0",
  filename: "inspire-pi-gui-0.1.0.tgz",
};

describe("npm package manifest compatibility", () => {
  it.each([
    ["array", [record]],
    ["direct object", record],
    ["package-name keyed object", { "inspire-pi-gui": record }],
  ])("extracts npm's %s record", (_name, manifest) => {
    expect(npmPackageRecord(JSON.stringify(manifest), "npm pack")).toEqual(
      record,
    );
  });

  it("rejects JSON that does not contain a package record", () => {
    expect(() => npmPackageRecord('{"package":{}}', "npm pack")).toThrow(
      "did not report a package record",
    );
  });
});
