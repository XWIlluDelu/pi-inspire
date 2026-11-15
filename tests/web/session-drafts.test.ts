// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionDrafts } from "../../src/session-drafts";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("restores text in its own partition and advances revision only on editing", () => {
  const drafts = new SessionDrafts();
  drafts.setText(null, "Start draft");
  drafts.setText("session-a", "Saved text");
  const draft = drafts.get("session-a");
  drafts.setText("session-a", draft.text);
  expect(drafts.get("session-a")).toBe(draft);
  const restored = new SessionDrafts();
  expect(restored.get("session-a").text).toBe("Saved text");
  expect(restored.get(null).text).toBe("Start draft");
  drafts.clear("session-a");
  expect(drafts.get("session-a").revision).toBeGreaterThan(draft.revision);
  expect(new SessionDrafts().get("session-a").text).toBe("");
});

it("keeps editing when tab storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });
  const drafts = new SessionDrafts();
  drafts.setText("session-a", "Unsent text");
  expect(drafts.get("session-a").text).toBe("Unsent text");
});
