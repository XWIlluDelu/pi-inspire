import { describe, expect, it } from "vitest";
import {
  buildFileRegistry,
  selectedWorkspacePath,
} from "../../src/file-registry";
import type { ResourceRow } from "../../src/resources";

const reference: ResourceRow = {
  key: "reference:1",
  name: "App.tsx",
  label: "App.tsx",
  reference: "./src/App.tsx#L12",
  source: "link",
  extension: "md",
};

describe("file registry", () => {
  it("merges workspace and citation spellings into one sourced entry", () => {
    const entries = buildFileRegistry(
      [{ name: "App.tsx", path: "src/App.tsx" }],
      [reference],
      { "./src/App.tsx#L12": "src/App.tsx" },
      8,
    );

    expect(entries).toEqual([
      expect.objectContaining({
        key: "workspace:src/App.tsx",
        reference: "src/App.tsx",
        workspacePath: "src/App.tsx",
        workspace: true,
        referenced: true,
        recent: true,
      }),
    ]);
  });

  it("retains conversation-only files as separate authorized references", () => {
    const entries = buildFileRegistry([], [reference], {}, 8);

    expect(entries).toEqual([
      expect.objectContaining({
        key: "reference:./src/App.tsx#L12",
        reference: "./src/App.tsx#L12",
        workspace: false,
        referenced: true,
      }),
    ]);
  });

  it("uses the ready descriptor as the canonical selected path", () => {
    expect(
      selectedWorkspacePath({
        selectedResourceReference: "App.tsx",
        resourceWorkspacePaths: {},
        resourcePreview: {
          status: "ready",
          descriptor: { workspacePath: "src/App.tsx" },
        },
      }),
    ).toBe("src/App.tsx");
  });

  it("retains lightweight workspace selection after preview authority clears", () => {
    expect(
      selectedWorkspacePath({
        selectedResourceReference: null,
        resourceWorkspacePaths: {},
        resourcePreview: null,
        workspaceSelectedPath: "src/App.tsx",
      }),
    ).toBe("src/App.tsx");
  });
});
