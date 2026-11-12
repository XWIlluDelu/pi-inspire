import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app.js";
import { registerModelSettingsRoutes } from "../../server/model-settings-routes.js";
import { ModelRuntime, piInstallation } from "../../server/pi-runtime.js";
import { PreferencesStore } from "../../server/preferences.js";
import {
  nativeOAuthDescriptors,
  ProviderAuthService,
} from "../../server/provider-auth.js";
import { ResourceStore } from "../../server/resources.js";
import type { RuntimeLike } from "../../server/runtime.js";
import type { ProviderLoginAttempt } from "../../shared/model-settings.js";
import type { ProviderAuthOperation } from "../../shared/provider-auth-bridge.js";
import { hostServices } from "../fixtures/host-services.js";

type NativeRuntime = Awaited<ReturnType<typeof ModelRuntime.create>>;
let root: string;
let authPath: string;
let runtime: NativeRuntime;
let service: ProviderAuthService;
let nativeOAuth: Awaited<ReturnType<typeof nativeOAuthDescriptors>>;
const oauthCredential = {
  type: "oauth" as const,
  refresh: "synthetic-refresh-secret",
  access: "synthetic-access-secret",
  expires: Date.now() + 3_600_000,
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inspire-provider-auth-"));
  authPath = join(root, "auth.json");
  await writeFile(authPath, "{}");
  runtime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const base = runtime.getProvider("anthropic")!;
  runtime.registerNativeProvider({
    ...base,
    id: "synthetic",
    name: "Synthetic provider",
    getModels: () => [],
    auth: {
      apiKey: {
        name: "Synthetic API key",
        login: async (interaction) => {
          const account = await interaction.prompt({
            type: "text",
            message: "Account ID",
          });
          const key = await interaction.prompt({
            type: "secret",
            message: "API key",
          });
          return { type: "api_key", key, env: { ACCOUNT: account } };
        },
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key } } : undefined,
      },
      oauth: {
        name: "Synthetic authorization",
        login: async (interaction) => {
          const method = await interaction.prompt({
            type: "select",
            message: "Method",
            options: [
              { id: "device", label: "Device" },
              { id: "manual", label: "Manual redirect" },
            ],
          });
          interaction.notify(
            method === "device"
              ? {
                  type: "device_code",
                  userCode: "ABCD-EFGH",
                  verificationUri: "https://example.invalid/device",
                }
              : {
                  type: "auth_url",
                  url: "https://example.invalid/authorize",
                  instructions: "Paste the redirect URL",
                },
          );
          await interaction.prompt({
            type: "manual_code",
            message: "Authorization code",
            signal: interaction.signal,
          });
          return oauthCredential;
        },
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
  });
  nativeOAuth = await nativeOAuthDescriptors(piInstallation.sdkEntryPath);
  service = new ProviderAuthService(runtime, undefined, undefined, nativeOAuth);
});
afterEach(async () => {
  service?.close();
  await rm(root, { recursive: true, force: true });
});
async function prompt(attempt: ProviderLoginAttempt, type: string) {
  await vi.waitFor(() =>
    expect(service.snapshot(attempt.id).prompt?.type).toBe(type),
  );
  return service.snapshot(attempt.id).prompt!;
}
async function completed(attempt: ProviderLoginAttempt) {
  await vi.waitFor(() =>
    expect(service.snapshot(attempt.id).status).toBe("completed"),
  );
}
async function finishApiKeyLogin(
  attempt: ProviderLoginAttempt,
  account: string,
  key: string,
) {
  service.answer(attempt.id, (await prompt(attempt, "text")).id, account);
  service.answer(attempt.id, (await prompt(attempt, "secret")).id, key);
  await completed(attempt);
}

function authRoutes(runtime: Partial<RuntimeLike> = {}) {
  const app = express();
  app.use(express.json());
  registerModelSettingsRoutes(app, {
    runtime: runtime as RuntimeLike,
    providerAuth: service,
  });
  app.use(
    (
      error: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(error.status ?? 500).json({ error: error.message }),
  );
  return (operation: ProviderAuthOperation, sessionId?: string) =>
    request(app)
      .post("/api/provider-auth")
      .query(sessionId ? { sessionId } : {})
      .send(operation);
}

describe("public native provider authentication", () => {
  it("adapts API-key, text, secret, method, device-code and manual inputs without projecting credential values", async () => {
    const options = await service.providers();
    expect(
      options
        .find((provider) => provider.id === "synthetic")
        ?.methods.map((method) => method.type),
    ).toEqual(["api_key", "oauth"]);
    const attempt = service.start("synthetic", "api_key");
    await finishApiKeyLogin(attempt, "test-account", "synthetic-key-secret");
    expect(JSON.parse(await readFile(authPath, "utf8")).synthetic).toEqual({
      type: "api_key",
      key: "synthetic-key-secret",
      env: { ACCOUNT: "test-account" },
    });
    expect(JSON.stringify(service.snapshot(attempt.id))).not.toContain(
      "synthetic-key-secret",
    );
    expect(JSON.stringify(await service.providers())).not.toContain(
      "synthetic-key-secret",
    );
    const oauth = service.start("synthetic", "oauth");
    service.answer(oauth.id, (await prompt(oauth, "select")).id, "device");
    const code = await prompt(oauth, "manual_code");
    expect(service.snapshot(oauth.id).events).toContainEqual({
      type: "device_code",
      userCode: "ABCD-EFGH",
      url: "https://example.invalid/device",
    });
    service.answer(oauth.id, code.id, "one-use-code-secret");
    await completed(oauth);
    const providers = await service.providers();
    const metadata = JSON.stringify(providers);
    expect(metadata).not.toContain("synthetic-access-secret");
    expect(metadata).not.toContain("synthetic-refresh-secret");
    expect(
      providers.find((provider) => provider.id === "synthetic")?.stored,
    ).toBe("oauth");
    await service.logout("synthetic");
    expect(
      JSON.parse(await readFile(authPath, "utf8")).synthetic,
    ).toBeUndefined();
    expect(runtime.getProvider("synthetic")).toBeDefined();
  });

  it("cancels superseded and per-prompt operations before an old login can publish credentials", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = runtime.getProvider("synthetic")!;
    runtime.registerNativeProvider({
      ...base,
      auth: {
        ...base.auth,
        oauth: {
          ...base.auth.oauth!,
          login: async (interaction) => {
            interaction.notify({ type: "progress", message: "Waiting" });
            await blocked; // deliberately uncooperative provider: Models checks abort before persistence
            return oauthCredential;
          },
        },
      },
    });
    const old = service.start("synthetic", "oauth");
    await vi.waitFor(() =>
      expect(service.snapshot(old.id).events).toHaveLength(1),
    );
    const replacement = service.start("synthetic", "api_key");
    expect(service.snapshot(old.id).status).toBe("cancelled");
    release();
    await finishApiKeyLogin(replacement, "account", "new-key");
    expect(
      JSON.parse(await readFile(authPath, "utf8")).synthetic,
    ).toMatchObject({ type: "api_key", key: "new-key" });
    const abortPrompt = new AbortController();
    runtime.registerNativeProvider({
      ...base,
      auth: {
        ...base.auth,
        oauth: {
          ...base.auth.oauth!,
          login: async (interaction) => {
            const manual = interaction
              .prompt({
                type: "manual_code",
                message: "Paste code",
                signal: abortPrompt.signal,
              })
              .catch(() => "callback won");
            abortPrompt.abort();
            await manual;
            return oauthCredential;
          },
        },
      },
    });
    const callback = service.start("synthetic", "oauth");
    await completed(callback);
    expect(service.snapshot(callback.id).prompt).toBeNull();
  });

  it("joins a retired worker's stop fence before a new Host login can write global credentials", async () => {
    let live = true;
    let stopped!: () => void;
    const stopFence = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    let stopRequested = false;
    const worker = new ProviderAuthService(runtime);
    const owner = {
      id: "worker-A",
      cancelLogin: async (id: string) => {
        stopRequested = true;
        worker.cancel(id);
        await stopFence;
      },
    };
    const dispatch = async (
      _sessionId: string,
      operation: {
        operation: string;
        provider?: string;
        type?: "api_key" | "oauth";
        id?: string;
      },
    ) => {
      if (!live)
        throw Object.assign(new Error("No active Pi authentication owner"), {
          status: 409,
        });
      if (operation.operation === "start")
        return worker.start(operation.provider!, operation.type!);
      if (operation.operation === "cancel") return worker.cancel(operation.id!);
      throw new Error("Unexpected worker operation");
    };
    const post = authRoutes({
      sessionCwd: () => root,
      providerAuth: dispatch,
      providerAuthOwner: () => (live ? owner : null),
    });
    const {
      body: { result: old },
    } = await post(
      { operation: "start", provider: "synthetic", type: "oauth" },
      "worker-session",
    ).expect(200);
    live = false;
    let returned = false;
    const replacement = post({
      operation: "start",
      provider: "synthetic",
      type: "api_key",
    }).then((response) => {
      returned = true;
      return response;
    });
    try {
      await vi.waitFor(() => expect(stopRequested).toBe(true));
      expect(returned).toBe(false);
      stopped();
      const next = await replacement;
      expect(next.status).toBe(200);
      expect(worker.snapshot(old.id).status).toBe("cancelled");
      const { body } = await post({ operation: "status", id: old.id }).expect(
        200,
      );
      expect(body.result.status).toBe("cancelled");
      await finishApiKeyLogin(next.body.result, "host-account", "new-host-key");
      expect(
        JSON.parse(await readFile(authPath, "utf8")).synthetic,
      ).toMatchObject({
        type: "api_key",
        key: "new-host-key",
      });
    } finally {
      stopped();
      worker.close();
    }
  });

  it("keeps settled receipts within a bounded window without evicting pending attempts", async () => {
    const pending: ProviderLoginAttempt = {
      id: "pending",
      provider: "pending",
      type: "oauth",
      status: "pending",
      prompt: null,
      events: [],
    };
    const native = vi
      .spyOn(service, "request")
      .mockImplementation(async (operation) => {
        if (operation.operation === "start") {
          return {
            ...pending,
            id: operation.provider,
            provider: operation.provider,
          };
        }
        if (operation.operation === "status") {
          return {
            ...pending,
            id: operation.id,
            provider: operation.id,
            status: operation.id === pending.id ? "pending" : "completed",
          };
        }
        throw new Error("Unexpected native operation");
      });
    const post = authRoutes();
    const start = (provider: string) =>
      post({ operation: "start", provider, type: "oauth" }).expect(200);
    const status = (id: string) => post({ operation: "status", id });
    const settle = async (provider: string) => {
      await start(provider);
      return status(provider).expect(200);
    };
    await start(pending.provider);
    const { body: receipt } = await settle("oldest");
    native.mockClear();
    await status("oldest").expect(200, receipt);
    await post({ operation: "cancel", id: "oldest" }).expect(200, receipt);
    expect(native).not.toHaveBeenCalled();

    for (let index = 0; index < 20; index++) await settle(`completed-${index}`);
    const { body: latest } = await settle("latest");
    await status("oldest").expect(404);
    await status("latest").expect(200, latest);
    await status(pending.id).expect(200, { result: pending });
  });

  it("offers remote help only for matching native providers and login methods", async () => {
    const openai = runtime.getProvider("openai")!;
    const oauthMethod = (
      providers: Awaited<ReturnType<ProviderAuthService["providers"]>>,
      id: string,
    ) =>
      providers
        .find((provider) => provider.id === id)!
        .methods.find((method) => method.type === "oauth")!;
    expect(
      oauthMethod(await service.providers(), openai.id).remoteHelp,
    ).toMatch(/redirect URL/);

    const native = service.start("anthropic", "oauth");
    const next = await prompt(native, "select");
    expect(
      next.options?.find((option) => option.id === "copy_code")?.remoteHelp,
    ).toMatch(/paste.*code/);
    expect(
      next.options?.find((option) => option.id === "browser")?.remoteHelp,
    ).toBeUndefined();
    service.answer(native.id, next.id, "copy_code");
    await prompt(native, "manual_code");
    expect(service.snapshot(native.id).events).toContainEqual(
      expect.objectContaining({
        type: "auth_url",
        url: expect.stringMatching(/^https:/),
      }),
    );
    service.cancel(native.id);

    const anthropic = runtime.getProvider("anthropic")!;
    runtime.registerNativeProvider({
      ...anthropic,
      auth: {
        ...anthropic.auth,
        oauth: {
          ...anthropic.auth.oauth!,
          login: async (interaction) => {
            await interaction.prompt({
              type: "select",
              message: "Host-bound method",
              options: [{ id: "copy_code", label: "Reused native option ID" }],
            });
            return oauthCredential;
          },
        },
      },
    });
    const shadowed = service.start(anthropic.id, "oauth");
    expect(
      (await prompt(shadowed, "select")).options?.[0]?.remoteHelp,
    ).toBeUndefined();
    service.cancel(shadowed.id);

    const modelsPath = join(root, "models.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          openai: {
            name: openai.auth.oauth!.name,
            baseUrl: "https://radius.example.invalid/v1",
            oauth: "radius",
          },
        },
      }),
    );
    const configured = new ProviderAuthService(
      await ModelRuntime.create({
        authPath,
        modelsPath,
        refreshOnCreate: false,
      }),
      undefined,
      undefined,
      nativeOAuth,
    );
    try {
      expect(
        oauthMethod(await configured.providers(), openai.id).remoteHelp,
      ).toBeUndefined();
    } finally {
      configured.close();
    }
  });

  it("cancels a standalone native login when its Host closes", async () => {
    const application = createInspireServer({
      token: "fixture",
      ...hostServices(root),
      preferences: new PreferencesStore(join(root, "preferences.json")),
      resources: new ResourceStore(),
      git: {
        status: async () => ({ kind: "not-repository" }),
        diff: async () => {
          throw new Error("unused");
        },
      },
      providerAuth: service,
      version: "fixture",
      piVersion: piInstallation.version,
    });
    try {
      const attempt = service.start("synthetic", "oauth");
      await prompt(attempt, "select");
      await application.close();
      expect(service.snapshot(attempt.id)).toMatchObject({
        status: "cancelled",
        prompt: null,
      });
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({});
      expect(() => service.start("synthetic", "oauth")).toThrow(
        "Provider authentication is closed",
      );
    } finally {
      await application.close();
    }
  });

  it("redacts native authentication failures", async () => {
    const base = runtime.getProvider("synthetic")!;
    runtime.registerNativeProvider({
      ...base,
      auth: {
        ...base.auth,
        oauth: {
          ...base.auth.oauth!,
          login: async () => {
            throw new Error("HTTP body contains access_token=raw-token-secret");
          },
        },
      },
    });
    const attempt = service.start("synthetic", "oauth");
    await vi.waitFor(() =>
      expect(service.snapshot(attempt.id).status).toBe("failed"),
    );
    expect(service.snapshot(attempt.id).message).toMatch(
      /Pi could not complete login/,
    );
    expect(JSON.stringify(service.snapshot(attempt.id))).not.toContain(
      "raw-token-secret",
    );
  });
});
