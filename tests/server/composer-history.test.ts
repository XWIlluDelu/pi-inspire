import { describe, expect, it } from "vitest";
import {
  MAX_COMPOSER_HISTORY_ENTRIES,
  MAX_COMPOSER_HISTORY_PAGE_BYTES,
} from "../../shared/contracts.js";
import {
  composerHistoryEntries,
  projectComposerHistoryPage,
} from "../../server/composer-history.js";

const owner = {
  sessionId: "session-a",
  revision: 7,
  viewId: "view-a",
  incarnation: "projection-a",
  effectiveLeafId: "leaf-a",
};

describe("composer history projection", () => {
  it("reproduces Pi's trimmed, newest-first, consecutive-deduplicated history", () => {
    expect(
      composerHistoryEntries([
        { role: "user", content: "  one  " },
        { role: "assistant", content: [{ type: "text", text: "ignored" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "two" },
            { type: "image", data: "ignored" },
            { type: "text", text: " parts" },
          ],
        },
        { role: "user", content: "two parts" },
        { role: "user", content: "   " },
        { role: "user", content: "one" },
      ]),
    ).toEqual(["one", "two parts", "one"]);

    const bounded = composerHistoryEntries(
      Array.from({ length: 105 }, (_, index) => ({
        role: "user",
        content: `prompt-${index}`,
      })),
    );
    expect(bounded).toHaveLength(MAX_COMPOSER_HISTORY_ENTRIES);
    expect(bounded[0]).toBe("prompt-104");
    expect(bounded.at(-1)).toBe("prompt-5");
  });

  it("pages exact entries under the serialized response bound", () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: "user",
      content: `${index}:${"\0".repeat(10_000)}`,
    }));
    const first = projectComposerHistoryPage(messages, owner);
    expect(first.nextStart).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      MAX_COMPOSER_HISTORY_PAGE_BYTES,
    );

    const second = projectComposerHistoryPage(
      messages,
      owner,
      first.nextStart ?? 0,
    );
    expect(second.historyId).toBe(first.historyId);
    expect([...first.entries, ...second.entries]).toHaveLength(100);
    expect(second.nextStart).toBeNull();
  });
});
