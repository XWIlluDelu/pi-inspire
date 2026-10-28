import { describe, expect, it } from "vitest";
import { createInitialAppState } from "../../src/app-state";
import type { ResourceFileTab } from "../../src/resource-preview";
import {
  readFileReading,
  readWorkbench,
  saveWorkbench,
  workbenchSessionKey,
} from "../../src/workbench-session";

describe("file-tab navigation metadata", () => {
  it("restores the Git view and comparison without turning a display label into a workspace path", () => {
    const key = workbenchSessionKey("session", "/project")!;
    const tabs: ResourceFileTab[] = [
      {
        reference: "src/example.ts",
        workspacePath: "src/example.ts",
        view: "changes",
        git: {
          pathId: "path-1",
          side: "staged",
          displayPath: "src/example.ts",
        },
      },
      {
        reference: "git-path-2",
        git: {
          pathId: "path-2",
          side: "unstaged",
          displayPath: "invalid-�.txt",
        },
      },
    ];
    saveWorkbench(key, {
      ...createInitialAppState(),
      resourceTabs: tabs,
      selectedResourceReference: "git-path-2",
      fileBrowserView: "preview",
    });

    expect(readWorkbench(key)).toMatchObject({
      resourceTabs: tabs.map((tab) => ({
        ...tab,
        git: { ...tab.git, side: "worktree" },
      })),
      selectedResourceReference: "git-path-2",
      selectedResourceWorkspacePath: null,
      fileBrowserView: "preview",
    });
    expect(
      readWorkbench(workbenchSessionKey("other-session", "/project")),
    ).toBeNull();
  });

  it("ignores malformed Git metadata and unknown views while keeping valid file tabs", () => {
    const key = workbenchSessionKey("session", "/project")!;
    sessionStorage.setItem(
      key,
      JSON.stringify({
        resourceTabs: [
          {
            reference: "one.ts",
            view: "future-mode",
            git: { pathId: "one", side: "both", displayPath: "one.ts" },
          },
          {
            reference: "two.ts",
            view: "changes",
            git: { pathId: "", side: "staged", displayPath: "two.ts" },
          },
          {
            reference: "three.ts",
            git: { pathId: "three", side: "unstaged", displayPath: 3 },
          },
          { reference: "four.ts", git: ["four", "staged", "four.ts"] },
        ],
      }),
    );
    expect(readWorkbench(key)?.resourceTabs).toEqual([
      { reference: "one.ts" },
      { reference: "two.ts", view: "changes" },
      { reference: "three.ts" },
      { reference: "four.ts" },
    ]);
  });
});

describe("per-file comparison reading metadata", () => {
  it("restores independent comparison sides alongside the existing body views", () => {
    const key = workbenchSessionKey("session", "/project")!;
    const reading = readFileReading(key, "example.md");
    reading.source.current = { top: 120, left: 8 };
    reading.rendered.current = { top: 240, left: 0 };
    reading.mode = "preview";
    reading.changes = {
      worktree: { top: 600, left: 10, activeChange: 3 },
      staged: { top: 360, left: 16, activeChange: 2 },
      unstaged: { top: 480, left: 32, activeChange: null },
    };
    reading.save?.();

    expect(readFileReading(key, "example.md")).toMatchObject({
      source: { current: reading.source.current },
      rendered: { current: reading.rendered.current },
      mode: "preview",
      changes: reading.changes,
    });
    expect(readFileReading(key, "other.md").changes).toEqual({});
    expect(
      readFileReading(
        workbenchSessionKey("other-session", "/project"),
        "example.md",
      ).changes,
    ).toEqual({});
  });

  it("rejects invalid offsets and clears an invalid active-change index", () => {
    const key = workbenchSessionKey("session", "/project")!;
    const storageKey = `${key}:reading:${JSON.stringify("example.md")}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        source: { top: 20, left: 0 },
        mode: "changes",
        changes: {
          staged: { top: -1, left: 0, activeChange: 0 },
          unstaged: { top: 80, left: 2, activeChange: 1.5 },
          other: { top: 90, left: 3, activeChange: 1 },
        },
      }),
    );
    const reading = readFileReading(key, "example.md");
    expect(reading.source.current).toEqual({ top: 20, left: 0 });
    expect(reading.mode).toBeUndefined();
    expect(reading.changes).toEqual({
      unstaged: { top: 80, left: 2, activeChange: null },
      worktree: { top: 80, left: 2, activeChange: null },
    });
  });

  it.each([
    ["staged", 360],
    ["unstaged", 480],
    ["worktree", 480],
  ] as const)(
    "migrates the saved %s comparison's reading position",
    (side, top) => {
      const key = workbenchSessionKey("session", "/project")!;
      sessionStorage.setItem(
        key,
        JSON.stringify({
          resourceTabs: [{ reference: "example.md", git: { side } }],
        }),
      );
      sessionStorage.setItem(
        `${key}:reading:${JSON.stringify("example.md")}`,
        JSON.stringify({
          source: { top: 120, left: 8 },
          rendered: { top: 240, left: 0 },
          mode: "source",
          changes: {
            staged: { top: 360, left: 0, activeChange: 1 },
            unstaged: { top: 480, left: 0, activeChange: 2 },
          },
        }),
      );
      const reading = readFileReading(key, "example.md");
      expect(reading).toMatchObject({
        source: { current: { top: 120, left: 8 } },
        rendered: { current: { top: 240, left: 0 } },
        mode: "source",
        changes: {
          staged: { top: 360 },
          unstaged: { top: 480 },
          worktree: { top },
        },
      });
    },
  );

  it("preserves the old selected comparison before restored tab metadata is saved", () => {
    const key = workbenchSessionKey("session", "/project")!;
    saveWorkbench(key, {
      ...createInitialAppState(),
      resourceTabs: [
        {
          reference: "example.md",
          workspacePath: "example.md",
          view: "changes",
          git: { pathId: "path", side: "staged", displayPath: "example.md" },
        },
      ],
      selectedResourceReference: "example.md",
      fileBrowserView: "preview",
    });
    sessionStorage.setItem(
      `${key}:reading:${JSON.stringify("example.md")}`,
      JSON.stringify({
        source: { top: 120, left: 0 },
        changes: {
          staged: { top: 360, left: 0, activeChange: 1 },
          unstaged: { top: 480, left: 0, activeChange: 2 },
        },
      }),
    );
    const restored = readWorkbench(key)!;
    expect(restored.resourceTabs[0].git?.side).toBe("worktree");
    saveWorkbench(key, { ...createInitialAppState(), ...restored });
    const reading = readFileReading(key, "example.md");
    expect(reading.changes?.worktree).toEqual({
      top: 360,
      left: 0,
      activeChange: 1,
    });
    expect(reading.source.current).toEqual({ top: 120, left: 0 });
    reading.changes!.worktree = { top: 600, left: 10, activeChange: 3 };
    reading.save?.();
    expect(readFileReading(key, "example.md").changes?.worktree).toEqual({
      top: 600,
      left: 10,
      activeChange: 3,
    });
  });
});
