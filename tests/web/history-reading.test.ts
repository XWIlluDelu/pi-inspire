import { expect, it, vi } from "vitest";
import {
  readHistoryReading,
  workbenchSessionKey,
} from "../../src/workbench-session";

it("restores History navigation metadata in its session and workspace only", () => {
  const key = workbenchSessionKey("session", "/project")!;
  const reading = readHistoryReading(key);
  expect(reading.restored).toBe(false);
  Object.assign(reading, {
    query: "formula",
    expanded: ["branch-one", "branch-two"],
    selectedEntryId: "entry",
    routeLeafId: "leaf",
    outline: { top: 100, left: 4 },
    detail: { top: 300, left: 8 },
  });
  reading.save?.();
  expect(reading.restored).toBe(true);
  expect(readHistoryReading(key)).toMatchObject({
    restored: true,
    query: "formula",
    expanded: ["branch-one", "branch-two"],
    selectedEntryId: "entry",
    routeLeafId: "leaf",
    outline: { top: 100, left: 4 },
    detail: { top: 300, left: 8 },
  });
  for (const other of [
    workbenchSessionKey("other", "/project"),
    workbenchSessionKey("session", "/other"),
    null,
  ]) {
    expect(readHistoryReading(other)).toMatchObject({
      restored: false,
      query: "",
      expanded: [],
      selectedEntryId: null,
      routeLeafId: null,
      outline: { top: 0, left: 0 },
      detail: { top: 0, left: 0 },
    });
  }
});

it("validates saved navigation fields and excludes content from later saves", () => {
  const key = workbenchSessionKey("session", "/project")!;
  sessionStorage.setItem(
    `${key}:history`,
    JSON.stringify({
      query: 10,
      expanded: ["one", "", "one", 5, "two"],
      selectedEntryId: "",
      routeLeafId: [],
      outline: { top: -1, left: 0 },
      detail: { top: 300, left: null },
      content: "must not persist",
      loading: true,
    }),
  );
  const reading = readHistoryReading(key);
  expect(reading).toMatchObject({
    restored: false,
    query: "",
    expanded: ["one", "two"],
    selectedEntryId: null,
    routeLeafId: null,
    outline: { top: 0, left: 0 },
    detail: { top: 0, left: 0 },
  });
  reading.save?.();
  expect(JSON.parse(sessionStorage.getItem(`${key}:history`)!)).toEqual({
    query: "",
    expanded: ["one", "two"],
    selectedEntryId: null,
    routeLeafId: null,
    outline: { top: 0, left: 0 },
    detail: { top: 0, left: 0 },
  });
});

it("keeps in-memory History navigation usable when storage is refused", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Storage unavailable", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage unavailable", "SecurityError");
  });
  const reading = readHistoryReading(
    workbenchSessionKey("session", "/project"),
  );
  reading.query = "formula";
  reading.selectedEntryId = "entry";
  expect(() => reading.save?.()).not.toThrow();
  expect(reading.query).toBe("formula");
  expect(reading.selectedEntryId).toBe("entry");
  expect(reading.restored).toBe(true);
});

it("distinguishes a saved top position from first-visit endpoint placement", () => {
  const key = workbenchSessionKey("session", "/project")!;
  const reading = readHistoryReading(key);
  expect(reading.restored).toBe(false);
  reading.save?.();
  expect(readHistoryReading(key)).toMatchObject({
    restored: true,
    outline: { top: 0, left: 0 },
  });
  expect(
    JSON.parse(sessionStorage.getItem(`${key}:history`)!),
  ).not.toHaveProperty("restored");
});
