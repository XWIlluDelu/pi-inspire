import { expect, it } from "vitest";
import { createInitialAppState } from "../../src/app-state";
import {
  readFileReading,
  readWorkbench,
  saveWorkbench,
  workbenchSessionKey,
} from "../../src/workbench-session";

const key = workbenchSessionKey("session", "/project")!;
const otherWorkspace = workbenchSessionKey("session", "/elsewhere")!;

it("round-trips a raw Git identity while dropping unknown and malformed tab fields", () => {
  const opaque = {
    reference: "pi-git://raw",
    view: "changes" as const,
    git: { pathId: "raw", displayPath: "invalid-�.txt" },
  };
  saveWorkbench(key, {
    ...createInitialAppState(),
    resourceTabs: [opaque, { reference: "pi-embedded://1/0" }],
    fileInspection: {
      kind: "file",
      reference: opaque.reference,
      preview: null,
    },
  });
  const record = JSON.parse(sessionStorage.getItem(key)!);
  expect(record.resourceTabs).toEqual([opaque]);
  record.resourceTabs.push(
    { reference: "one.ts", view: "future-mode", git: { pathId: "one" } },
    {
      reference: "two.ts",
      view: "changes",
      git: { pathId: "", displayPath: "two.ts" },
    },
    { reference: "three.ts", git: { pathId: "three", displayPath: 3 } },
    { reference: "four.ts", git: ["four", "four.ts"] },
    { reference: "four.ts", workspacePath: "duplicate.ts" },
  );
  sessionStorage.setItem(key, JSON.stringify(record));
  expect(readWorkbench(key)).toMatchObject({
    resourceTabs: [
      opaque,
      { reference: "one.ts" },
      { reference: "two.ts", view: "changes" },
      { reference: "three.ts" },
      { reference: "four.ts" },
    ],
    fileInspection: {
      kind: "file",
      reference: opaque.reference,
      preview: null,
      workspacePath: undefined,
    },
  });
  const old = key.replace("dock-v2:", "dock:");
  sessionStorage.setItem(old, JSON.stringify(record));
  sessionStorage.removeItem(key);
  expect(readWorkbench(key)).toBeNull();
});

it("keeps comparison offsets independent of the selected reader and drops invalid saved positions", () => {
  const name = "example.md";
  const reading = readFileReading(key, name);
  reading.source.current = { top: 120, left: 8 };
  reading.rendered.current = { top: 240, left: 0 };
  reading.mode = "preview";
  reading.changes = { top: 600, left: 10, activeChange: 3 };
  reading.save?.();
  expect(readFileReading(key, name)).toMatchObject({
    source: { current: reading.source.current },
    rendered: { current: reading.rendered.current },
    mode: "preview",
    changes: reading.changes,
  });
  expect(readFileReading(key, "other.md").changes).toBeUndefined();
  expect(readFileReading(otherWorkspace, name).changes).toBeUndefined();

  const storageKey = `${key}:reading:${JSON.stringify(name)}`;
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      source: reading.source.current,
      rendered: { top: -1, left: 0 },
      mode: "changes",
      changes: { top: 600, left: 10, activeChange: 1.5 },
    }),
  );
  expect(readFileReading(key, name)).toMatchObject({
    source: { current: reading.source.current },
    rendered: { current: null },
    changes: { top: 600, left: 10, activeChange: null },
  });
  expect(readFileReading(key, name).mode).toBeUndefined();
});
