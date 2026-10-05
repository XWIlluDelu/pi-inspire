import { expect, it } from "vitest";
import {
  composerArtifactReference,
  parseComposerArtifactReference,
} from "../../shared/composer-artifact-references";

it("round-trips stable entry identities without confusing them with transcript context indices", () => {
  const message = { __inspireHistoryEntryId: "user/中文" };
  const image = composerArtifactReference("image", message, 0, 3);
  const file = composerArtifactReference("file", message, 0, 1);
  expect(parseComposerArtifactReference("image", image)).toEqual([
    "user/中文",
    3,
  ]);
  expect(parseComposerArtifactReference("file", file)).toEqual([
    "user/中文",
    1,
  ]);
  expect(parseComposerArtifactReference("image", "pi-embedded://2/3")).toEqual([
    2, 3,
  ]);
  expect(parseComposerArtifactReference("file", "pi-file://2/1")).toEqual([
    2, 1,
  ]);
  expect(parseComposerArtifactReference("image", file)).toBeNull();
  for (const invalid of [
    "pi-history-image://%zz/0",
    "pi-history-image://%75ser/0",
    "pi-history-image://user/-1",
    "pi-history-image://user/9007199254740992",
  ]) {
    expect(parseComposerArtifactReference("image", invalid)).toBeNull();
  }
});
