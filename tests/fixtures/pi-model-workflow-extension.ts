import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export function registerModelWorkflow(
  pi: ExtensionAPI,
  scope: string,
  includeRouter = true,
) {
  const mark = (event: string) => {
    if (process.env.INSPIRE_MODEL_FIXTURE_EVENTS)
      appendFileSync(
        process.env.INSPIRE_MODEL_FIXTURE_EVENTS,
        `${scope}:${event}\n`,
      );
  };
  mark("factory");
  const models: Model<"openai-completions">[] = ["a", "b"].map((id, index) => ({
    provider: `${scope}-native`,
    id,
    name: `${scope} physical ${id}`,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1",
    reasoning: true,
    input: ["text"],
    contextWindow: index ? 64_000 : 16_000,
    maxTokens: 128,
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  }));
  const stream = (
    model: Model<"openai-completions">,
    _context: unknown,
    options?: SimpleStreamOptions,
  ) => {
    mark("request");
    const result = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        thinkingLevel: options?.reasoning ?? "off",
        content: [{ type: "text", text: `${model.name} reply` }],
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: model.id === "a" ? 1000 : 2000,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: model.id === "a" ? 1010 : 2010,
          cost: {
            input: 0.001,
            output: 0.00001,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.00101,
          },
        },
      };
      result.push({ type: "start", partial: message });
      result.push({ type: "done", reason: "stop", message });
      result.end();
    });
    return result;
  };
  pi.registerProvider({
    id: `${scope}-native`,
    name: `${scope} native`,
    getModels: () => models,
    auth: {
      apiKey: {
        name: "Fixture",
        resolve: async () => ({ auth: { apiKey: "synthetic" } }),
      },
    },
    stream,
    streamSimple: stream,
  });
  pi.registerProvider(`${scope}-legacy`, {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "synthetic",
    models: [{ ...models[0]!, id: "legacy", name: `${scope} legacy` }],
  });
  if (includeRouter)
    pi.registerVirtualModel<{ n: number }>({
      provider: `${scope}-router`,
      id: "auto",
      name: `${scope} router`,
      thinkingLevels: ["low", "high"],
      route(request, ctx) {
        mark("route");
        const n = (request.state?.n ?? 0) + 1;
        return {
          model: ctx.modelRegistry.find(`${scope}-native`, n % 2 ? "a" : "b")!,
          thinkingLevel: "medium",
          state: { n },
        };
      },
    });
  pi.on("session_start", () => mark("session_start"));
  pi.on("before_agent_start", () => mark("agent_start"));
}

export default function (pi: ExtensionAPI) {
  registerModelWorkflow(pi, "global");
}
