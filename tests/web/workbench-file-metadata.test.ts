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
  it("restores the Git view without turning a display label into a workspace path", () => {
    const key = workbenchSessionKey("session", "/project")!;
    const tabs: ResourceFileTab[] = [
      {
        reference: "src/example.ts",
        workspacePath: "src/example.ts",
        view: "changes",
        git: {
          pathId: "path-1",
          displayPath: "src/example.ts",
        },
      },
      {
        reference: "git-path-2",
        git: {
          pathId: "path-2",
          displayPath: "invalid-�.txt",
        },
      },
    ];
    saveWorkbench(key, {
      ...createInitialAppState(),
      resourceTabs: tabs,
      fileInspection: { kind: "file", reference: "git-path-2", preview: null },
    });

    expect(readWorkbench(key)).toMatchObject({
      resourceTabs: tabs,
      fileInspection: { kind: "file", reference: "git-path-2", preview: null },
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
          { reference: "four.ts", workspacePath: "duplicate.ts" },
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
  it("restores the net comparison position independently of the body views", () => {
    const key = workbenchSessionKey("session", "/project")!;
    const reading = readFileReading(key, "example.md");
    reading.source.current = { top: 120, left: 8 };
    reading.rendered.current = { top: 240, left: 0 };
    reading.mode = "preview";
    reading.changes = { top: 600, left: 10, activeChange: 3 };
    reading.save?.();

    expect(readFileReading(key, "example.md")).toMatchObject({
      source: { current: reading.source.current },
      rendered: { current: reading.rendered.current },
      mode: "preview",
      changes: reading.changes,
    });
    expect(readFileReading(key, "other.md").changes).toBeUndefined();
    expect(
      readFileReading(
        workbenchSessionKey("other-session", "/project"),
        "example.md",
      ).changes,
    ).toBeUndefined();
  });

  it("rejects invalid offsets and clears an invalid active-change index", () => {
    const key = workbenchSessionKey("session", "/project")!;
    const storageKey = `${key}:reading:${JSON.stringify("example.md")}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        source: { top: 20, left: 0 },
        rendered: { top: -1, left: 0 },
        mode: "changes",
        changes: { top: 80, left: 2, activeChange: 1.5 },
      }),
    );
    const reading = readFileReading(key, "example.md");
    expect(reading.source.current).toEqual({ top: 20, left: 0 });
    expect(reading.rendered.current).toBeNull();
    expect(reading.mode).toBeUndefined();
    expect(reading.changes).toEqual({ top: 80, left: 2, activeChange: null });
  });

  it.each([
    ["staged", 360],
    ["unstaged", 480],
    ["worktree", 600],
  ] as const)(
    "migrates the saved %s comparison's reading position",
    (side, top) => {
      const key = workbenchSessionKey("session", "/project")!;
      sessionStorage.setItem(
        key,
        JSON.stringify({
          resourceTabs: [
            {
              reference: "example.md",
              view: "changes",
              git: { pathId: "path", side, displayPath: "example.md" },
            },
          ],
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
            ...(side === "worktree"
              ? { worktree: { top: 600, left: 0, activeChange: 3 } }
              : {}),
          },
        }),
      );
      expect(readWorkbench(key)?.resourceTabs).toEqual([
        {
          reference: "example.md",
          view: "changes",
          git: { pathId: "path", displayPath: "example.md" },
        },
      ]);
      const reading = readFileReading(key, "example.md");
      expect(reading).toMatchObject({
        source: { current: { top: 120, left: 8 } },
        rendered: { current: { top: 240, left: 0 } },
        mode: "source",
        changes: { top },
      });
      reading.save?.();
      expect(
        JSON.parse(
          sessionStorage.getItem(
            `${key}:reading:${JSON.stringify("example.md")}`,
          )!,
        ).changes,
      ).toEqual(reading.changes);
    },
  );

  it("preserves the old selected comparison before restored tab metadata is saved", () => {
    const key = workbenchSessionKey("session", "/project")!;
    sessionStorage.setItem(
      key,
      JSON.stringify({
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
      }),
    );
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
    expect(restored.resourceTabs[0].git).toEqual({
      pathId: "path",
      displayPath: "example.md",
    });
    saveWorkbench(key, { ...createInitialAppState(), ...restored });
    const reading = readFileReading(key, "example.md");
    expect(reading.changes).toEqual({
      top: 360,
      left: 0,
      activeChange: 1,
    });
    expect(reading.source.current).toEqual({ top: 120, left: 0 });
    reading.changes = { top: 600, left: 10, activeChange: 3 };
    reading.save?.();
    expect(readFileReading(key, "example.md").changes).toEqual({
      top: 600,
      left: 10,
      activeChange: 3,
    });
  });
});
