import { describe, expect, it } from "vitest";
import { directoryEntries } from "../../server/project-files.js";

describe("directoryEntries", () => {
  it("derives one directory level from the flat project index, folders first", () => {
    const paths = ["src/main.ts", "src/lib/util.ts", "README.md", "assets/logo.png"];
    expect(directoryEntries(paths, "")).toEqual([
      { name: "assets", type: "dir" },
      { name: "src", type: "dir" },
      { name: "README.md", type: "file" },
    ]);
    expect(directoryEntries(paths, "src")).toEqual([
      { name: "lib", type: "dir" },
      { name: "main.ts", type: "file" },
    ]);
    expect(directoryEntries(paths, "src/lib")).toEqual([{ name: "util.ts", type: "file" }]);
    expect(directoryEntries(paths, "missing")).toEqual([]);
  });

  it("never treats the requested dir as a filesystem path", () => {
    // A traversal-looking dir simply matches no indexed prefix.
    expect(directoryEntries(["src/main.ts"], "../etc")).toEqual([]);
  });
});
