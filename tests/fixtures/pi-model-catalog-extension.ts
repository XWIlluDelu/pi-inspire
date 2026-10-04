import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("extension-fixture", {
    api: "openai-completions",
    apiKey: "synthetic",
    baseUrl: "http://127.0.0.1:1",
    models: [
      {
        id: "extension-model",
        name: "Extension contribution",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 128,
      },
    ],
  });
  pi.registerCommand("catalog-hold", {
    description: "Fixture independent extension state",
    handler: async (_arg, ctx) => {
      const accepted = await ctx.ui.confirm(
        "Catalog fixture",
        "Keep this dialog open through refresh",
      );
      ctx.ui.setStatus("fixture-result", accepted ? "retained" : "declined");
    },
  });
}
