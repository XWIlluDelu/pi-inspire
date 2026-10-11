import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { refreshWorkerCatalog } from "../../server/model-catalog-refresh.js";
import { nativePiWorkspace, nativeBridgeWorker } from "./fixtures/native-pi.js";

it("refreshes usable models in the same active Pi worker and retains extension providers/dialogs/session selection", async () => {
  const workspace = await nativePiWorkspace("inspire-catalog-", {
    defaultProvider: "fixture",
    defaultModel: "original",
    defaultThinkingLevel: "high",
    defaultProjectTrust: "never",
    compaction: { enabled: false },
  });
  const { root, agent: config } = workspace;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  let requested = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* drain synthetic request */
    }
    requested = true;
    await gate;
    if (response.destroyed) return;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "original", choices: [{ index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const writeModels = (ids: string[]) =>
    writeFile(
      join(config, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            apiKey: "synthetic",
            baseUrl,
            models: ids.map((id) => ({
              id,
              name: id,
              reasoning: true,
              input: ["text"],
              contextWindow: 4096,
              maxTokens: 128,
            })),
          },
        },
      }),
    );
  await writeModels(["original"]);
  const { bridge, rpc } = nativeBridgeWorker(
    workspace,
    "tests/fixtures/pi-model-catalog-extension.ts",
  );
  const events: Array<Record<string, unknown>> = [];
  rpc.on("event", (event) => events.push(event));
  try {
    await rpc.start();
    const before = await rpc.request<Record<string, unknown>>({
      type: "get_state",
    });
    const pid = rpc.pid;
    const hold = rpc.request({ type: "prompt", message: "/catalog-hold" });
    await vi.waitFor(() =>
      expect(events.some((event) => event.method === "confirm")).toBe(true),
    );
    const dialog = events.find((event) => event.method === "confirm")!;
    await rpc.request({ type: "prompt", message: "Synthetic active request" });
    await vi.waitFor(() => expect(requested).toBe(true));
    expect(
      (await rpc.request<Record<string, unknown>>({ type: "get_state" }))
        .isStreaming,
    ).toBe(true);
    const entries = await rpc.request({ type: "get_entries" });
    const queue = events
      .filter((event) => event.type === "queue_update")
      .at(-1);
    await writeModels(["original", "new-model"]);
    // Raw RPC remains stale until the public worker-local refresh command runs.
    expect(
      (
        await rpc.request<{ models: Array<{ id: string }> }>({
          type: "get_available_models",
        })
      ).models.some((model) => model.id === "new-model"),
    ).toBe(false);
    await expect(
      refreshWorkerCatalog(rpc, bridge, String(before.sessionId)),
    ).resolves.toBeUndefined();
    const models = (
      await rpc.request<{ models: Array<{ provider: string; id: string }> }>({
        type: "get_available_models",
      })
    ).models;
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "new-model" }),
        expect.objectContaining({
          provider: "extension-fixture",
          id: "extension-model",
        }),
      ]),
    );
    const after = await rpc.request<Record<string, unknown>>({
      type: "get_state",
    });
    expect(rpc.pid).toBe(pid);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.sessionFile).toBe(before.sessionFile);
    expect(after.model).toEqual(before.model);
    expect(after.thinkingLevel).toBe(before.thinkingLevel);
    expect(after.isStreaming).toBe(true);
    expect(await rpc.request({ type: "get_entries" })).toEqual(entries);
    expect(
      events.filter((event) => event.type === "queue_update").at(-1),
    ).toEqual(queue);
    await expect(
      rpc.request({
        type: "set_model",
        provider: "fixture",
        modelId: "new-model",
      }),
    ).resolves.toMatchObject({ id: "new-model" });
    expect(
      (await rpc.request<Record<string, unknown>>({ type: "get_state" }))
        .isStreaming,
    ).toBe(true);
    await rpc.sendExtensionUiResponse({
      type: "extension_ui_response",
      id: dialog.id,
      confirmed: true,
    });
    await hold;
    expect(
      events.some(
        (event) =>
          event.statusKey === "fixture-result" &&
          event.statusText === "retained",
      ),
    ).toBe(true);
    release();
    await vi.waitFor(async () =>
      expect(
        (await rpc.request<Record<string, unknown>>({ type: "get_state" }))
          .isStreaming,
      ).toBe(false),
    );
  } finally {
    release();
    await rpc.stop();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
