import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Offline native execution fixture. Child results must stay with their parent. */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fixture_leaf",
    label: "Fixture leaf",
    description: "Synthetic child",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, fail: { type: "boolean" } },
      required: ["path"],
    },
    async execute(_id, input, signal, onUpdate) {
      const args = input as { path: string; fail?: boolean };
      onUpdate?.({
        content: [{ type: "text", text: "PRIVATE_CHILD_UPDATE" }],
        details: { privateChildData: true },
      });
      await delay(100, undefined, { signal });
      return {
        content: [
          {
            type: "text",
            text: args.fail ? "Synthetic child error" : "PRIVATE_CHILD_RESULT",
          },
        ],
        details: { privateChildData: true },
        ...(args.fail ? { isError: true } : {}),
      };
    },
  });
  pi.registerTool({
    name: "fixture_branch",
    label: "Fixture branch",
    description: "Nested child",
    parameters: { type: "object", properties: {} },
    async execute(_id, _args, signal, _onUpdate, ctx) {
      await ctx.executeTool("fixture_leaf", { path: "deep.txt" }, { signal });
      return {
        content: [{ type: "text", text: "PRIVATE_BRANCH_RESULT" }],
        details: undefined,
      };
    },
  });
  pi.registerTool({
    name: "fixture_parent",
    label: "Fixture parent",
    description: "Parent with independent outcome",
    parameters: { type: "object", properties: {} },
    async execute(_id, _args, signal, _onUpdate, ctx) {
      await Promise.all([
        ctx.executeTool("fixture_branch", {}, { signal }),
        ctx.executeTool(
          "fixture_leaf",
          { path: "failed.txt", fail: true },
          { signal },
        ),
      ]);
      return {
        content: [{ type: "text", text: "Parent survived" }],
        details: undefined,
      };
    },
  });
  pi.registerProvider("child-model-fixture", {
    apiKey: "synthetic",
    models: [
      {
        type: "classifier",
        id: "classifier",
        name: "Synthetic classifier",
        api: "fixture-classifier",
        baseUrl: "http://127.0.0.1:1",
        input: ["text"],
        contextWindow: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    classifiers: {
      "fixture-classifier": {
        async classify() {
          await delay(50);
          return {
            provider: "child-model-fixture",
            model: "classifier",
            answers: { useful: { type: "bool", probability: 0.9 } },
            stopReason: "stop",
          };
        },
      },
    },
  });
}
