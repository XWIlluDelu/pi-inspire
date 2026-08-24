import { expect, it } from "vitest";
import {
  discardComposerHistory,
  hydrateComposerHistory,
  rememberComposerHistory,
  type ComposerHistoryScope,
} from "../../src/composer-history";

it("merges prompts accepted while history hydration is in flight", async () => {
  const scope: ComposerHistoryScope = {
    sessionId: "history-race",
    viewId: "view-a",
    incarnation: "projection-a",
  };
  let resolve!: (entries: string[]) => void;
  const hydration = hydrateComposerHistory(
    scope,
    () =>
      new Promise<string[]>((accept) => {
        resolve = accept;
      }),
  );

  rememberComposerHistory(scope, "repeat");
  rememberComposerHistory(scope, "middle");
  rememberComposerHistory(scope, "repeat");
  // The Host captured only the first of those accepted prompts.
  resolve(["repeat", "existing"]);

  await expect(hydration).resolves.toEqual([
    "repeat",
    "middle",
    "repeat",
    "existing",
  ]);
  discardComposerHistory(scope.sessionId);
});
