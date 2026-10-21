import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { branchDeltaMatches } from "../../server/runtime-branch-bridge.js";
import type { BranchBridgeResult } from "../../shared/branch-bridge-protocol.js";

const result: BranchBridgeResult = {
  v: 1,
  nonce: "operation",
  workerId: "worker",
  sessionId: "session",
  ok: true,
  cancelled: false,
  beforeLeaf: "old",
  navigationLeaf: "target",
  effectiveLeaf: "state",
};
const timestamp = new Date(0).toISOString();
const delta: SessionEntry[] = [
  {
    type: "custom_message",
    id: "note",
    parentId: "target",
    timestamp,
    customType: "branch-note",
    content: "selected",
    display: true,
  },
  {
    type: "custom",
    id: "state",
    parentId: "note",
    timestamp,
    customType: "branch-state",
    data: {},
  },
];
it("accepts native callback effects only after the independently witnessed anchor", () => {
  expect(branchDeltaMatches(result, delta, "target", "old")).toBe(true);
  expect(
    branchDeltaMatches(
      { ...result, navigationLeaf: undefined },
      delta,
      "target",
      "old",
    ),
  ).toBe(false);
  expect(
    branchDeltaMatches(
      { ...result, navigationLeaf: "note" },
      delta,
      "target",
      "old",
    ),
  ).toBe(false);
  expect(
    branchDeltaMatches(
      { ...result, effectiveLeaf: "note" },
      delta,
      "target",
      "old",
    ),
  ).toBe(false);
  expect(branchDeltaMatches(result, delta, "old", "old")).toBe(false);
  expect(branchDeltaMatches(result, delta, "target", "other")).toBe(false);
  expect(
    branchDeltaMatches(
      result,
      [delta[0]!, { ...delta[1]!, parentId: "old" }],
      "target",
      "old",
    ),
  ).toBe(false);
});
it("verifies the native summary/label prefix before allowing callback appends", () => {
  const prefix: SessionEntry[] = [
    {
      type: "branch_summary",
      id: "summary",
      parentId: "target",
      fromId: "old",
      summary: "native",
      timestamp,
    },
    {
      type: "label",
      id: "label",
      parentId: "summary",
      targetId: "summary",
      label: "named",
      timestamp,
    },
  ];
  const entries = [...prefix, { ...delta[0]!, parentId: "label" }, delta[1]!];
  const summarized = {
    ...result,
    navigationLeaf: "label",
    summaryId: "summary",
  };
  expect(branchDeltaMatches(summarized, entries, "target", "old")).toBe(true);
  expect(
    branchDeltaMatches(
      { ...summarized, summaryId: "foreign" },
      entries,
      "target",
      "old",
    ),
  ).toBe(false);
});
