import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ModelRuntime,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  availableModelOptions,
  defaultModelOption,
  modelSettings,
} from "../../server/model-catalog.js";
import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from "../../server/pi-runtime.js";
import {
  appendModelSelection,
  branchModelSelection,
  selectedBranchModel,
} from "../../server/session-model-selection.js";
import { nativePiWorkspace } from "./fixtures/native-pi.js";

describe("new-session model catalog", () => {
  it("honors parent and workspace trust refusals without protected resources", async () => {
    const { root, agent, cwd } = await nativePiWorkspace(
      "inspire-model-trust-",
      {
        defaultProjectTrust: "always",
      },
    );
    try {
      await writeFile(join(cwd, "AGENTS.md"), "# Workspace instructions");
      expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
      const trust = new ProjectTrustStore(agent);
      const isTrusted = () => modelSettings(cwd, agent).isProjectTrusted();
      trust.set(root, false);
      expect(isTrusted()).toBe(false);
      trust.set(root, true);
      expect(isTrusted()).toBe(true);
      trust.set(cwd, false);
      expect(isTrusted()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose Pi's absent-model sentinel as a default", () => {
    expect(
      defaultModelOption({ provider: "unknown", id: "unknown" }),
    ).toBeNull();
  });

  it("projects only browser-safe picker metadata from Pi's available models", async () => {
    const runtime = {
      getAvailable: async () => [
        {
          provider: "anthropic",
          id: "claude-sonnet",
          name: "Claude Sonnet",
          reasoning: true,
          thinkingLevelMap: {
            minimal: "low",
            xhigh: "high",
            max: null,
            other: "ignored",
          },
          baseUrl: "https://secret.invalid",
          headers: { Authorization: "Bearer secret" },
          api: "anthropic-messages",
        },
      ],
    } as unknown as Pick<ModelRuntime, "getAvailable">;

    await expect(availableModelOptions(runtime)).resolves.toEqual([
      {
        provider: "anthropic",
        id: "claude-sonnet",
        name: "Claude Sonnet",
        reasoning: true,
        thinkingLevelMap: { minimal: "low", xhigh: "high", max: null },
      },
    ]);
  });
});

it("restores selected models from branch history and uses physical replies as fallback", () => {
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
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let incremental = branchModelSelection(byId, null);
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
