import { expect, it } from "vitest";
import {
  discardComposerHistory,
  recentComposerHistory,
  rememberComposerHistory,
} from "../../src/composer-history";

it("keeps accepted inputs in order across saved appends without guessing duplicate identity", () => {
  const scope = {
    sessionId: "recent-inputs",
    viewId: "view-a",
    incarnation: "projection-a",
    effectiveLeafId: "leaf-a",
    historyVersion: "history-a",
  };
  const first = { text: "same caption", images: [], files: [] };
  const second = { ...first };
  rememberComposerHistory(scope, first);
  rememberComposerHistory(scope, second);
  const updated = {
    ...scope,
    effectiveLeafId: "leaf-b",
    historyVersion: "history-b",
  };
  expect(recentComposerHistory(updated)).toEqual([second, first]);
  expect(recentComposerHistory({ ...updated, viewId: "view-b" })).toEqual([]);
  discardComposerHistory(scope.sessionId);
  expect(recentComposerHistory(updated)).toEqual([]);
});
