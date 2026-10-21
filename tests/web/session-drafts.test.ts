// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.resetModules();
});

it("restores exact text after module reload, isolated by session and start surface", async () => {
  const drafts = await import("../../src/session-drafts");
  drafts.setSessionDraft("session/a", "  unsent\ntext 中文  ");
  drafts.setSessionDraft("session/b", "other session");
  drafts.setStartDraft("new conversation");
  vi.resetModules();
  const reopened = await import("../../src/session-drafts");
  expect(reopened.sessionDraft("session/a")).toBe("  unsent\ntext 中文  ");
  expect(reopened.sessionDraft("session/b")).toBe("other session");
  expect(reopened.startDraft()).toBe("new conversation");
  expect(reopened.sessionDraft("start")).toBe("");
  expect(
    [...Array(window.sessionStorage.length)].map((_, index) =>
      window.sessionStorage.getItem(window.sessionStorage.key(index)!),
    ),
  ).toEqual(
    expect.arrayContaining([
      "new conversation",
      "other session",
      "  unsent\ntext 中文  ",
    ]),
  );
});

it("does not resurrect sent, explicitly cleared, transferred, or deleted-session drafts", async () => {
  const drafts = await import("../../src/session-drafts");
  for (const id of ["sent", "cleared", "deleted"])
    drafts.setSessionDraft(id, id);
  drafts.setStartDraft("transferred");
  drafts.setSessionDraft("sent", "");
  drafts.setSessionDraft("cleared", "");
  drafts.deleteSessionDraft("deleted");
  drafts.setStartDraft("");
  vi.resetModules();
  const reopened = await import("../../src/session-drafts");
  for (const id of ["sent", "cleared", "deleted"])
    expect(reopened.sessionDraft(id)).toBe("");
  expect(reopened.startDraft()).toBe("");
  expect(window.sessionStorage.length).toBe(0);
});

it("hydrates each partition once, including empty and cleared drafts", async () => {
  const getItem = vi.spyOn(
    Object.getPrototypeOf(window.sessionStorage),
    "getItem",
  );
  const drafts = await import("../../src/session-drafts");
  expect(drafts.sessionDraft("typing")).toBe("");
  for (let index = 0; index < 200; index += 1) {
    drafts.setSessionDraft("typing", `edit ${index}`);
    expect(drafts.sessionDraft("typing")).toBe(`edit ${index}`);
  }
  const revision = drafts.sessionDraftRevision("typing");
  drafts.setSessionDraft("typing", "edit 199");
  expect(drafts.sessionDraftRevision("typing")).toBe(revision);
  drafts.deleteSessionDraft("typing");
  expect(drafts.sessionDraft("typing")).toBe("");
  expect(drafts.sessionDraftRevision("typing")).toBe(revision + 1);
  expect(getItem).toHaveBeenCalledOnce();

  expect(drafts.startDraft()).toBe("");
  drafts.setStartDraft("start");
  expect(drafts.startDraft()).toBe("start");
  drafts.setStartDraft("");
  expect(drafts.startDraft()).toBe("");
  expect(drafts.sessionDraft("empty")).toBe("");
  expect(drafts.sessionDraft("empty")).toBe("");
  expect(getItem).toHaveBeenCalledTimes(3);
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
