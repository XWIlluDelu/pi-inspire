import { setTimeout as delay } from "node:timers/promises";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type Model,
  type TranscriptContext,
  type StreamOptions,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Offline model boundary only. Pi owns persistence, queues, streaming and cancellation. */
export default function (pi: ExtensionAPI) {
  const models: Model<"openai-completions">[] = ["offline", "secondary"].map(
    (id) => ({
      id,
      provider: "workbench",
      name: id === "offline" ? "Offline model" : "Secondary model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 131_072,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  );
  const stream = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: StreamOptions,
  ) => {
    const result = createAssistantMessageEventStream();
    const user = context.messages.findLast(
      (message) => message.role === "user",
    );
    const prompt =
      typeof user?.content === "string"
        ? user.content
        : (user?.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n") ?? "");
    const text = `You asked: **${prompt || "about the attached material"}**.\n\nThe offline provider supplies inline math $a^2+b^2=c^2$ and display math:\n\n$$\\int_0^1 x^2\\,dx=\\frac13$$`;
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      thinkingLevel: (options as SimpleStreamOptions)?.reasoning ?? "off",
      content: [{ type: "text", text: "" }],
      timestamp: Date.now(),
      stopReason: "stop",
      usage: {
        input: 1000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    void (async () => {
      result.push({ type: "start", partial: message });
      result.push({ type: "text_start", contentIndex: 0, partial: message });
      try {
        for (const delta of text.match(/.{1,14}/gs) ?? [text]) {
          await delay(
            Number(process.env.INSPIRE_FIXTURE_STREAM_INTERVAL_MS ?? 0),
            undefined,
            { signal: options?.signal },
          );
          (message.content[0] as { text: string }).text += delta;
          result.push({
            type: "text_delta",
            contentIndex: 0,
            delta,
            partial: message,
          });
        }
        result.push({
          type: "text_end",
          contentIndex: 0,
          content: text,
          partial: message,
        });
        result.push({ type: "done", reason: "stop", message });
      } catch (error) {
        if (!options?.signal?.aborted) throw error;
        message.stopReason = "aborted";
        result.push({ type: "error", reason: "aborted", error: message });
      } finally {
        result.end();
      }
    })();
    return result;
  };
  pi.registerProvider({
    id: "workbench",
    name: "Offline workbench",
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
  pi.on("session_before_tree", (event) =>
    event.preparation.userWantsSummary
      ? {
          summary: {
            summary: "Retain the fixture decisions and remaining work.",
          },
        }
      : undefined,
  );
  pi.on("session_before_compact", (event) => ({
    compaction: {
      summary: "Retain the fixture's decisions and remaining work.",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    },
  }));
}
