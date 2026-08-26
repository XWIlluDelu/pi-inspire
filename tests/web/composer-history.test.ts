import { expect, it } from "vitest";
import type { ComposerHistoryEntry } from "../../shared/contracts";
import {
  type ComposerHistoryScope,
  composerHistory,
  discardComposerHistory,
  hydrateComposerHistory,
  rememberComposerHistory,
} from "../../src/composer-history";

const entry = (text: string): ComposerHistoryEntry => ({
  text,
  images: [],
  files: [],
});

it("merges prompts accepted while history hydration is in flight", async () => {
  const scope: ComposerHistoryScope = {
    sessionId: "history-race",
    viewId: "view-a",
    incarnation: "projection-a",
    effectiveLeafId: null,
  };
  let resolve!: (entries: ComposerHistoryEntry[]) => void;
  const hydration = hydrateComposerHistory(
    scope,
    () =>
      new Promise<ComposerHistoryEntry[]>((accept) => {
        resolve = accept;
      }),
  );

  rememberComposerHistory(scope, "repeat");
  rememberComposerHistory(scope, "middle");
  rememberComposerHistory(scope, "repeat");
  // The Host captured only the first of those accepted prompts.
  resolve([entry("repeat"), entry("existing")]);

  await expect(hydration).resolves.toEqual([
    entry("repeat"),
    entry("middle"),
    entry("repeat"),
    entry("existing"),
  ]);
  discardComposerHistory(scope.sessionId);
});

it("does not let an evicted hydration replace a newer partition", async () => {
  const scope: ComposerHistoryScope = {
    sessionId: "evicted-history",
    viewId: "view-original",
    incarnation: "projection-original",
    effectiveLeafId: null,
  };
  let resolve!: (entries: ComposerHistoryEntry[]) => void;
  const staleHydration = hydrateComposerHistory(
    scope,
    () =>
      new Promise<ComposerHistoryEntry[]>((accept) => {
        resolve = accept;
      }),
  );

  for (let index = 0; index < 12; index += 1) {
    composerHistory({
      ...scope,
      sessionId: `other-${index}`,
      viewId: `view-${index}`,
    });
  }
  rememberComposerHistory(scope, "new local prompt");
  resolve([entry("stale host prompt")]);

  await expect(staleHydration).resolves.toEqual([]);
  expect(composerHistory(scope)).toEqual([entry("new local prompt")]);
  discardComposerHistory(scope.sessionId);
  for (let index = 0; index < 12; index += 1) {
    discardComposerHistory(`other-${index}`);
  }
});
