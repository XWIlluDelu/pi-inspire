import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { refreshWorkerCatalog } from "../../server/model-catalog-refresh.js";
import { requestWorkerAuth } from "../../server/provider-auth-bridge.js";
import type {
  ProviderLoginAttempt,
  ProviderLoginOption,
} from "../../shared/model-settings.js";
import { nativePiWorkspace, nativeBridgeWorker } from "./fixtures/native-pi.js";

it("uses the live extension provider's native login and refreshes availability without changing the session", async () => {
  const workspace = await nativePiWorkspace("inspire-worker-auth-", {
    defaultProjectTrust: "never",
    compaction: { enabled: false },
  });
  const { root, agent: config } = workspace;
  const { bridge, rpc } = nativeBridgeWorker(
    workspace,
    "tests/fixtures/pi-provider-auth-extension.ts",
  );
  try {
    await rpc.start();
    const before = await rpc.request<Record<string, unknown>>({
      type: "get_state",
    });
    const sessionId = String(before.sessionId);
    const pid = rpc.pid;
    const entries = await rpc.request({ type: "get_entries" });
    const request = (operation: Parameters<typeof requestWorkerAuth>[3]) =>
      requestWorkerAuth(rpc, bridge, sessionId, operation);
    const providers = (await request({
      operation: "providers",
    })) as ProviderLoginOption[];
    expect(
      providers.find((provider) => provider.id === "extension-auth-fixture"),
    ).toMatchObject({ stored: null, methods: [{ type: "api_key" }] });
    await rpc.request({ type: "prompt", message: "/change-auth-method" });
    await writeFile(
      join(config, "models.json"),
      JSON.stringify({
        providers: {
          "new-config-provider": {
            baseUrl: "https://example.invalid/v1",
            api: "openai-completions",
            models: [{ id: "new", contextWindow: 4096, maxTokens: 128 }],
          },
        },
      }),
    );
    await refreshWorkerCatalog(rpc, bridge, sessionId);
    const fresh = (await request({
      operation: "providers",
    })) as ProviderLoginOption[];
    expect(
      fresh.find((provider) => provider.id === "new-config-provider")?.methods,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "api_key" })]),
    );
    expect(
      fresh.find((provider) => provider.id === "extension-auth-fixture")
        ?.methods[0]?.label,
    ).toBe("Updated fixture API key");
    const attempt = (await request({
      operation: "start",
      provider: "extension-auth-fixture",
      type: "api_key",
    })) as ProviderLoginAttempt;
    let state = attempt;
    await vi.waitFor(async () => {
      state = (await request({
        operation: "status",
        id: attempt.id,
      })) as ProviderLoginAttempt;
      expect(state.prompt?.type).toBe("secret");
    });
    expect(state.prompt?.message).toBe("Updated fixture API key");
    await request({
      operation: "answer",
      id: attempt.id,
      promptId: state.prompt!.id,
      value: "worker-synthetic-secret",
    });
    await vi.waitFor(async () => {
      state = (await request({
        operation: "status",
        id: attempt.id,
      })) as ProviderLoginAttempt;
      expect(state.status).toBe("completed");
    });
    expect(JSON.stringify(state)).not.toContain("worker-synthetic-secret");
    expect(
      JSON.parse(await readFile(join(config, "auth.json"), "utf8"))[
        "extension-auth-fixture"
      ],
    ).toMatchObject({ type: "api_key", key: "worker-synthetic-secret" });
    await refreshWorkerCatalog(rpc, bridge, sessionId);
    const models = await rpc.request<{
      models: Array<{ provider: string; id: string }>;
    }>({ type: "get_available_models" });
    expect(models.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "extension-auth-fixture",
          id: "fixture-model",
        }),
      ]),
    );
    const after = await rpc.request<Record<string, unknown>>({
      type: "get_state",
    });
    expect(rpc.pid).toBe(pid);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.model).toEqual(before.model);
    expect(after.thinkingLevel).toEqual(before.thinkingLevel);
    expect(await rpc.request({ type: "get_entries" })).toEqual(entries);
    await rpc.request({ type: "prompt", message: "/remove-auth-provider" });
    await writeFile(
      join(config, "models.json"),
      JSON.stringify({ providers: {} }),
    );
    await refreshWorkerCatalog(rpc, bridge, sessionId);
    const removed = (await request({
      operation: "providers",
    })) as ProviderLoginOption[];
    expect(
      removed.find((provider) => provider.id === "new-config-provider"),
    ).toBeUndefined();
    expect(
      removed.find((provider) => provider.id === "extension-auth-fixture"),
    ).toMatchObject({ stored: "api_key", methods: [] });
    await expect(
      request({
        operation: "start",
        provider: "extension-auth-fixture",
        type: "api_key",
      }),
    ).rejects.toThrow(/authentication operation/);
    await request({ operation: "logout", provider: "extension-auth-fixture" });
    await refreshWorkerCatalog(rpc, bridge, sessionId);
    expect(
      (
        await rpc.request<{ models: Array<{ provider: string }> }>({
          type: "get_available_models",
        })
      ).models.some((model) => model.provider === "extension-auth-fixture"),
    ).toBe(false);
    expect(
      JSON.parse(await readFile(join(config, "auth.json"), "utf8"))[
        "extension-auth-fixture"
      ],
    ).toBeUndefined();
  } finally {
    await rpc.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
