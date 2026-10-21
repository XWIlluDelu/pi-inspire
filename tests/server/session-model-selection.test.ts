import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import {
  appendModelSelection,
  branchModelSelection,
  selectedBranchModel,
} from "../../server/session-model-selection.js";

const router = {
  provider: "router",
  id: "auto",
  name: "Auto",
  virtual: true,
  reasoning: true,
};
const entries = [
  {
    type: "model_change",
    id: "select",
    parentId: null,
    provider: "router",
    modelId: "auto",
  },
  {
    type: "message",
    id: "reply",
    parentId: "select",
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "physical",
      model: "a",
    },
  },
  {
    type: "message",
    id: "failed-route",
    parentId: "reply",
    message: {
      role: "assistant",
      api: "pi-virtual",
      provider: "router",
      model: "auto",
      stopReason: "error",
    },
  },
  {
    type: "model_change",
    id: "physical-choice",
    parentId: "failed-route",
    provider: "physical",
    modelId: "a",
  },
  {
    type: "message",
    id: "physical-reply",
    parentId: "physical-choice",
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "physical",
      model: "b",
    },
  },
] as SessionEntry[];

it("recovers registered virtual choices and legacy response choices identically from full branches and incremental append", () => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let incremental = { change: null, fallback: null } as ReturnType<
    typeof appendModelSelection
  >;
  for (const entry of entries) {
    incremental = appendModelSelection(incremental, [entry]);
    expect(incremental).toEqual(branchModelSelection(byId, entry.id));
  }
  const routed = branchModelSelection(byId, "failed-route");
  expect(selectedBranchModel(routed, [router])).toEqual(router);
  expect(selectedBranchModel(routed, [])).toEqual({
    provider: "physical",
    id: "a",
  });
  expect(selectedBranchModel(incremental, [router])).toEqual({
    provider: "physical",
    id: "b",
  });
});
