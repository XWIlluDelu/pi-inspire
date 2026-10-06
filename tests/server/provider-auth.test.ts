import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app.js";
import { AttachmentStore } from "../../server/attachments.js";
import { MockCatalog, MockRuntime } from "../../server/mock.js";
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
  vi.unstubAllGlobals();
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

describe("public native provider authentication", () => {
  it("adapts API-key, text, secret, method, device-code and manual inputs without projecting credential values", async () => {
    const options = await service.providers();
    expect(
      options
        .find((provider) => provider.id === "synthetic")
        ?.methods.map((method) => method.type),
    ).toEqual(["api_key", "oauth"]);
    const attempt = service.start("synthetic", "api_key");
    let next = await prompt(attempt, "text");
    service.answer(attempt.id, next.id, "test-account");
    next = await prompt(attempt, "secret");
    service.answer(attempt.id, next.id, "synthetic-key-secret");
    await completed(attempt);
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
    next = await prompt(oauth, "select");
    service.answer(oauth.id, next.id, "device");
    next = await prompt(oauth, "manual_code");
    expect(service.snapshot(oauth.id).events).toContainEqual({
      type: "device_code",
      userCode: "ABCD-EFGH",
      url: "https://example.invalid/device",
    });
    service.answer(oauth.id, next.id, "one-use-code-secret");
    await completed(oauth);
    const metadata = JSON.stringify(await service.providers());
    expect(metadata).not.toContain("synthetic-access-secret");
    expect(metadata).not.toContain("synthetic-refresh-secret");
    expect(
      (await service.providers()).find(
        (provider) => provider.id === "synthetic",
      )?.stored,
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
    let next = await prompt(replacement, "text");
    service.answer(replacement.id, next.id, "account");
    next = await prompt(replacement, "secret");
    service.answer(replacement.id, next.id, "new-key");
    await completed(replacement);
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
    const app = express();
    app.use(express.json());
    registerModelSettingsRoutes(app, {
      runtime: {
        sessionCwd: () => root,
        providerAuth: dispatch,
        providerAuthOwner: () => (live ? owner : null),
      } as unknown as RuntimeLike,
      providerAuth: service,
    } as Parameters<typeof registerModelSettingsRoutes>[1]);
    app.use(
      (
        error: Error & { status?: number },
        _request: express.Request,
        response: express.Response,
        _next: express.NextFunction,
      ) => {
        response.status(error.status ?? 500).json({ error: error.message });
      },
    );
    const old = await request(app)
      .post("/api/provider-auth?sessionId=worker-session")
      .send({ operation: "start", provider: "synthetic", type: "oauth" });
    expect(old.status).toBe(200);
    live = false;
    let returned = false;
    const replacement = request(app)
      .post("/api/provider-auth")
      .send({ operation: "start", provider: "synthetic", type: "api_key" })
      .then((response) => {
        returned = true;
        return response;
      });
    await vi.waitFor(() => expect(stopRequested).toBe(true));
    expect(returned).toBe(false);
    stopped();
    const next = await replacement;
    expect(next.status).toBe(200);
    expect(worker.snapshot(old.body.result.id).status).toBe("cancelled");
    for (let read = 0; read < 2; read++) {
      const receipt = await request(app)
        .post("/api/provider-auth")
        .send({ operation: "status", id: old.body.result.id });
      expect(receipt.status).toBe(200);
      expect(receipt.body.result.status).toBe("cancelled");
    }
    const attempt = next.body.result as ProviderLoginAttempt;
    let input = await prompt(attempt, "text");
    service.answer(attempt.id, input.id, "host-account");
    input = await prompt(attempt, "secret");
    service.answer(attempt.id, input.id, "new-host-key");
    await completed(attempt);
    expect(
      JSON.parse(await readFile(authPath, "utf8")).synthetic,
    ).toMatchObject({ type: "api_key", key: "new-host-key" });
    worker.close();
  });

  it.skipIf(!piInstallation.version.startsWith("1."))(
    "keeps installed Pi remote help positive and method-specific",
    async () => {
      const nativeOptions = await service.providers();
      expect(
        nativeOptions
          .find((provider) => provider.id === "openai")
          ?.methods.find((method) => method.type === "oauth")?.remoteHelp,
      ).toMatch(/redirect URL/);
      expect(
        nativeOptions
          .find((provider) => provider.id === "synthetic")
          ?.methods.find((method) => method.type === "oauth")?.remoteHelp,
      ).toBeUndefined();
      for (const id of ["openai", "anthropic"]) {
        const native = runtime.getProvider(id)!;
        runtime.registerNativeProvider({
          ...native,
          auth: {
            ...native.auth,
            oauth: {
              ...native.auth.oauth!,
              login: async (interaction) => {
                await interaction.prompt({
                  type: "select",
                  message: "Host-bound method",
                  options: [
                    { id: "copy_code", label: "Reused native option ID" },
                  ],
                });
                return oauthCredential;
              },
              toAuth: async (credential) => ({ apiKey: credential.access }),
            },
          },
        });
        const existing = new ProviderAuthService(
          runtime,
          undefined,
          undefined,
          nativeOAuth,
        );
        const methods = (await existing.providers()).find(
          (provider) => provider.id === id,
        )!.methods;
        expect(
          methods.find((method) => method.type === "oauth")?.remoteHelp,
        ).toBeUndefined();
        const replaced = service.start(id, "oauth");
        const choice = await prompt(replaced, "select");
        expect(choice.options?.[0]?.remoteHelp).toBeUndefined();
        service.answer(replaced.id, choice.id, "copy_code");
        await completed(replaced);
      }
      const radiusPath = join(root, "radius-models.json");
      const nativeName = runtime.getProvider("openai")!.auth.oauth!.name;
      await writeFile(
        radiusPath,
        JSON.stringify({
          providers: {
            openai: {
              name: nativeName,
              baseUrl: "https://radius.example.invalid/v1",
              oauth: "radius",
            },
          },
        }),
      );
      const radius = await ModelRuntime.create({
        authPath,
        modelsPath: radiusPath,
        refreshOnCreate: false,
      });
      expect(radius.getError()).toBeUndefined();
      expect(radius.getRegisteredProviderIds()).not.toContain("openai");
      expect(radius.getProvider("openai")!.auth.oauth!.name).toBe(nativeName);
      const configured = new ProviderAuthService(
        radius,
        undefined,
        undefined,
        nativeOAuth,
      );
      const radiusMethod = (await configured.providers())
        .find((provider) => provider.id === "openai")!
        .methods.find((method) => method.type === "oauth");
      expect(radiusMethod).toBeDefined();
      expect(radiusMethod!.remoteHelp).toBeUndefined();
    },
  );

  it("cancels a standalone native login when its Host closes", async () => {
    const application = createInspireServer({
      token: "fixture",
      runtime: new MockRuntime(),
      catalog: new MockCatalog(),
      attachments: new AttachmentStore(join(root, "uploads")),
      preferences: new PreferencesStore(join(root, "preferences.json")),
      resources: new ResourceStore(),
      git: {
        status: async () => ({ kind: "not-repository" }),
        diff: async () => {
          throw new Error("unused");
        },
      },
      providerAuth: service,
      mock: true,
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

  it.skipIf(!piInstallation.version.startsWith("1."))(
    "completes installed Pi's real Anthropic copy-code method with a synthetic token transport",
    async () => {
      const fetch = vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          expect(String(url)).toBe(
            "https://platform.claude.com/v1/oauth/token",
          );
          expect(JSON.parse(String(init?.body))).toMatchObject({
            grant_type: "authorization_code",
            code: "fixture-code",
            redirect_uri: "https://platform.claude.com/oauth/code/callback",
          });
          return new Response(
            JSON.stringify({
              access_token: "native-access-secret",
              refresh_token: "native-refresh-secret",
              expires_in: 3600,
            }),
            { status: 200 },
          );
        },
      );
      vi.stubGlobal("fetch", fetch);
      const attempt = service.start("anthropic", "oauth");
      let next = await prompt(attempt, "select");
      expect(
        next.options?.find((option) => option.id === "copy_code")?.remoteHelp,
      ).toMatch(/paste.*code/);
      expect(
        next.options?.find((option) => option.id === "browser")?.remoteHelp,
      ).toBeUndefined();
      service.answer(attempt.id, next.id, "copy_code");
      next = await prompt(attempt, "manual_code");
      const url = new URL(
        service
          .snapshot(attempt.id)
          .events.find((event) => event.type === "auth_url")!.url!,
      );
      service.answer(
        attempt.id,
        next.id,
        `fixture-code#${url.searchParams.get("state")}`,
      );
      await completed(attempt);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(await readFile(authPath, "utf8")).anthropic,
      ).toMatchObject({ type: "oauth", access: "native-access-secret" });
      expect(JSON.stringify(service.snapshot(attempt.id))).not.toContain(
        "native-access-secret",
      );
    },
  );
});
