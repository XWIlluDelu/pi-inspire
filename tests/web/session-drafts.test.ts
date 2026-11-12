// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.resetModules();
});

it("advances the delivery guard only when draft text changes", async () => {
  const drafts = await import("../../src/session-drafts");
  drafts.setSessionDraft("typing", "draft");
  const revision = drafts.sessionDraftRevision("typing");
  drafts.setSessionDraft("typing", "draft");
  expect(drafts.sessionDraftRevision("typing")).toBe(revision);
  drafts.deleteSessionDraft("typing");
  expect(drafts.sessionDraftRevision("typing")).toBeGreaterThan(revision);
});

it("keeps ordinary typing/send-clear behavior when storage is denied or quota is exhausted", async () => {
  const drafts = await import("../../src/session-drafts");
  drafts.setSessionDraft("quota", "old persisted text");
  vi.spyOn(
    Object.getPrototypeOf(window.sessionStorage),
    "setItem",
  ).mockImplementation(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });
  drafts.setSessionDraft("quota", "new unsent text");
  expect(drafts.sessionDraft("quota")).toBe("new unsent text");
  expect(
    window.sessionStorage.getItem("inspire:composer-draft:v1:session:quota"),
  ).toBe("old persisted text");
  drafts.setSessionDraft("quota", "");
  expect(drafts.sessionDraft("quota")).toBe("");
  vi.spyOn(
    Object.getPrototypeOf(window.sessionStorage),
    "getItem",
  ).mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  vi.spyOn(
    Object.getPrototypeOf(window.sessionStorage),
    "removeItem",
  ).mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  drafts.setSessionDraft("private", "memory draft");
  expect(drafts.sessionDraft("private")).toBe("memory draft");
  drafts.deleteSessionDraft("private");
  expect(drafts.sessionDraft("private")).toBe("");
});
