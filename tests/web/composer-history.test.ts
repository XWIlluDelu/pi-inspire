import { expect, it } from "vitest";
import type { ComposerHistoryEntry } from "../../shared/contracts";
import {
  type ComposerHistoryScope,
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
