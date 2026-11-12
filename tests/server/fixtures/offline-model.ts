import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      ready();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function startOfflineModel({
  reply,
  beforeReply,
  beforeFinish,
  usage,
}: {
  reply: string | ((requestNumber: number) => string);
  beforeReply?: (requestNumber: number) => Promise<void> | undefined;
  beforeFinish?: () => Promise<void>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}) {
  const requests: Array<{ body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        request.method !== "POST" ||
        request.url !== "/v1/chat/completions" ||
        typeof body?.model !== "string"
      ) {
        response.writeHead(400).end("Unexpected offline model request");
        return;
      }
      const model = body.model;
      const requestNumber = requests.push({ body });
      await beforeReply?.(requestNumber);
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: Record<string, string>, finish: "stop" | null) =>
        `data: ${JSON.stringify({
          id: `chatcmpl-fixture-${requestNumber}`,
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(finish && usage ? { usage } : {}),
        })}\n\n`;
      response.write(
        chunk(
          {
            role: "assistant",
            content: typeof reply === "string" ? reply : reply(requestNumber),
          },
          null,
        ),
      );
      await beforeFinish?.();
      if (response.destroyed) return;
      response.write(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(400).end("Invalid offline model request");
    }
  });
  const baseUrl = `${await listenOnLoopback(server)}/v1`;
  return {
    baseUrl,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((closed, reject) => {
        server.close((error) => (error ? reject(error) : closed()));
      });
    },
  };
}

export function writeOfflineModels(
  agent: string,
  baseUrl: string,
  provider: string,
  models: ReadonlyArray<{
    id: string;
    name?: string;
    reasoning?: boolean;
    input?: readonly ("text" | "image")[];
    contextWindow?: number;
    maxTokens?: number;
  }>,
) {
  return writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        [provider]: {
          api: "openai-completions",
          apiKey: "synthetic",
          baseUrl,
          models: models.map((model) => ({
            name: model.id,
            reasoning: false,
            input: ["text"],
            contextWindow: 8192,
            maxTokens: 128,
            ...model,
          })),
        },
      },
    }),
  );
}
