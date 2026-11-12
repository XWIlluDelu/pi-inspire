import { expect, it } from "vitest";
import {
  composerArtifactReference,
  parseComposerArtifactReference,
} from "../../shared/composer-artifact-references";

it("round-trips stable entry identities without confusing them with transcript context indices", () => {
  const image = composerArtifactReference("image", "user/中文", 3);
  const file = composerArtifactReference("file", "user/中文", 1);
  expect(parseComposerArtifactReference("image", image)).toEqual([
    "user/中文",
    3,
  ]);
  expect(parseComposerArtifactReference("file", file)).toEqual([
    "user/中文",
    1,
  ]);
  expect(parseComposerArtifactReference("image", file)).toBeNull();
  for (const invalid of [
    "pi-embedded://2/3",
    "pi-history-image://%zz/0",
    "pi-history-image://%75ser/0",
    "pi-history-image://user/-1",
    "pi-history-image://user/9007199254740992",
  ]) {
    expect(parseComposerArtifactReference("image", invalid)).toBeNull();
  }
});
