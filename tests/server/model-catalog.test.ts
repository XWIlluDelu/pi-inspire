import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
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
import { nativePiWorkspace } from "./fixtures/native-pi.js";

describe("new-session model catalog", () => {
  it.each(["project", "parent"] as const)(
    "keeps a saved %s refusal authoritative even without protected resources",
    async (scope) => {
      const { root, agent, cwd } = await nativePiWorkspace(
        "inspire-model-trust-",
        {
          defaultProjectTrust: "always",
        },
      );
      try {
        await writeFile(join(cwd, "AGENTS.md"), "# Workspace instructions");
        const trust = new ProjectTrustStore(agent);
        trust.set(scope === "parent" ? root : cwd, false);
        expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
        expect(modelSettings(cwd, agent).isProjectTrusted()).toBe(false);
        expect(trust.get(cwd)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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
