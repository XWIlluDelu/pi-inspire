import { describe, expect, it } from "vitest";
import { createInitialAppState, type AppState } from "../../src/app-state";
import {
  deriveSnapshotTransition,
  snapshotLifecyclePatch,
} from "../../src/snapshot-transition";
import { activeSnapshot } from "./helpers";

function projectionState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...createInitialAppState(),
    sessionId: "s1",
    cwd: "/proj",
    transcriptRevision: 5,
    transcriptAppendFromRevision: 5,
    transcriptViewId: "view-s1",
    transcriptIncarnation: "projection-1",
    transcriptDurableLeafId: "a5",
    transcriptEffectiveLeafId: "a5",
    ...overrides,
  };
}

type SnapshotPageOverrides = NonNullable<
  Parameters<typeof activeSnapshot>[0]
>["transcriptPage"];

function snapshot(overrides: SnapshotPageOverrides = {}) {
  return activeSnapshot({
    durableLeafId: "a6",
    transcriptPage: {
      revision: 5,
      viewId: "view-s1",
      incarnation: "projection-1",
      appendFromRevision: 5,
      effectiveLeafId: "a6",
      ...overrides,
    },
  });
}

describe("snapshot transitions", () => {
  it.each([
    {
      name: "same projection",
      previous: projectionState(),
      next: snapshot(),
      kind: "same-projection",
    },
    {
      name: "append-compatible revision",
      previous: projectionState(),
      next: snapshot({ revision: 6, appendFromRevision: 5 }),
      kind: "append",
    },
    {
      name: "same-view replacement",
      previous: projectionState(),
      next: snapshot({ revision: 6, appendFromRevision: 6 }),
      kind: "projection-replaced",
    },
    {
      name: "view change",
      previous: projectionState(),
      next: snapshot({ viewId: "view-new" }),
      kind: "view-changed",
    },
    {
      name: "session change",
      previous: createInitialAppState(),
      next: snapshot(),
      kind: "session-changed",
    },
  ])("classifies $name", ({ previous, next, kind }) => {
    expect(deriveSnapshotTransition(previous, next, "preserve").kind).toBe(
      kind,
    );
  });

  it("preserves older rows while replacing a correlated live overlay", () => {
    const previous = projectionState({
      messages: [
        { role: "user", content: "older", __inspireMessageId: "u1" },
        {
          role: "assistant",
          content: "partial",
          timestamp: 10,
          __inspireLiveId: "live-a1",
        },
      ],
      hasOlderMessages: true,
      olderMessagesCursor: "older-1",
    });
    const next = snapshot({
      revision: 6,
      appendFromRevision: 5,
      messages: [
        {
          role: "assistant",
          content: "settled",
          timestamp: 10,
          __inspireMessageId: "a1",
        },
      ],
      hasOlder: true,
      olderCursor: "older-2",
    });

    const transition = deriveSnapshotTransition(previous, next, "preserve");

    expect(transition.historyCompatible).toBe(true);
    expect(transition.messages).toEqual([
      { role: "user", content: "older", __inspireMessageId: "u1" },
      {
        role: "assistant",
        content: "settled",
        timestamp: 10,
        __inspireMessageId: "a1",
      },
    ]);
  });

  it("makes lifecycle resets explicit for each ownership boundary", () => {
    const previous = projectionState({
      branchTree: {} as AppState["branchTree"],
      selectedResourceReference: "README.md",
      resourcePreview: {} as AppState["resourcePreview"],
      editorText: { text: "draft", nonce: 1 },
    });
    const sameProjection = deriveSnapshotTransition(
      previous,
      snapshot(),
      "preserve",
    );
    const appended = deriveSnapshotTransition(
      previous,
      snapshot({ revision: 6, appendFromRevision: 5 }),
      "preserve",
    );
    const replaced = deriveSnapshotTransition(
      previous,
      snapshot({ revision: 6, appendFromRevision: 6 }),
      "preserve",
    );
    const changedView = deriveSnapshotTransition(
      previous,
      snapshot({ viewId: "view-new" }),
      "preserve",
    );
    const changedSession = deriveSnapshotTransition(
      createInitialAppState(),
      snapshot(),
      "preserve",
    );

    expect(snapshotLifecyclePatch(previous, sameProjection)).toEqual({});
    expect(snapshotLifecyclePatch(previous, appended)).toEqual({});
    expect(snapshotLifecyclePatch(previous, replaced)).toMatchObject({
      selectedResourceReference: null,
      resourcePreview: null,
    });
    expect(snapshotLifecyclePatch(previous, changedView)).toMatchObject({
      branchTreeError:
        "Branch history is stale — refresh to use branch actions",
      branchActionId: null,
      selectedResourceReference: null,
    });
    expect(
      snapshotLifecyclePatch(previous, changedSession, {
        attachments: [],
        workspaceQuery: "restored",
      }),
    ).toMatchObject({
      editorText: null,
      contextMode: "files",
      branchTree: null,
      attachments: [],
      workspaceQuery: "restored",
      selectedGitPathId: null,
    });
  });
});
