import type { Express } from "express";
import { z } from "zod";
import { type ModelOption, THINKING_LEVELS } from "../shared/contracts.js";
import type { ModelConfigEdit } from "../shared/model-settings.js";
import type { ProviderAuthOperation } from "../shared/provider-auth-bridge.js";
import { modelOption } from "./model-catalog.js";
import type { ModelSettingsService } from "./model-settings.js";
import { resolveProjectDirectory } from "./paths.js";
import type { ProviderAuthService } from "./provider-auth.js";
import { requestError } from "./request-error.js";
import type { RuntimeLike } from "./runtime.js";

const token = z.string().min(1).max(256);
const querySchema = z.object({
  sessionId: token.optional(),
  cwd: z.string().min(1).max(4_096).optional(),
});
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const preferences = z
  .object({
    defaultModel: z
      .object({ provider: token, id: z.string().min(1).max(512) })
      .nullable()
      .optional(),
    defaultThinkingLevel: z.enum(THINKING_LEVELS).nullable().optional(),
    enabledModels: z.array(z.string().min(1).max(512)).max(512).optional(),
  })
  .strict();
const providerValues = z
  .object({
    baseUrl: z.string().max(4_096).nullable().optional(),
    api: token.nullable().optional(),
    apiKey: z.string().max(16_384).nullable().optional(),
  })
  .strict();
const modelValues = z
  .object({
    id: z.string().min(1).max(512),
    name: z.string().max(512).nullable().optional(),
    api: token.nullable().optional(),
    baseUrl: z.string().max(4_096).nullable().optional(),
    reasoning: z.boolean().nullable().optional(),
    input: z.array(z.string().max(100)).max(8).nullable().optional(),
    contextWindow: z.number().nullable().optional(),
    maxTokens: z.number().nullable().optional(),
    type: token.nullable().optional(),
  })
  .strict();
const configEdit = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("provider"), id: token, values: providerValues })
    .strict(),
  z.object({ kind: z.literal("remove-provider"), id: token }).strict(),
  z
    .object({
      kind: z.literal("model"),
      provider: token,
      originalId: z.string().max(512).optional(),
      originalType: token.optional(),
      values: modelValues,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove-model"),
      provider: token,
      id: z.string().min(1).max(512),
      type: token.optional(),
    })
    .strict(),
]);
const authOperation = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("providers") }),
  z.object({
    operation: z.literal("start"),
    provider: token,
    type: z.enum(["api_key", "oauth"]),
  }),
  z.object({ operation: z.literal("status"), id: token }),
  z.object({
    operation: z.literal("answer"),
    id: token,
    promptId: token,
    value: z.string().max(32_768),
  }),
  z.object({ operation: z.literal("cancel"), id: token }),
  z.object({ operation: z.literal("logout"), provider: token }),
]);
export function registerModelSettingsRoutes(
  app: Express,
  deps: {
    runtime: RuntimeLike;
    modelSettings?: ModelSettingsService;
    providerAuth?: ProviderAuthService;
    invalidateModels?: () => void;
    availableModels?: (
      refresh?: boolean,
      cwd?: string,
    ) => Promise<ModelOption[]>;
  },
): void {
  async function context(query: unknown) {
    const { sessionId, cwd } = querySchema.parse(query);
    const root = sessionId
      ? deps.runtime.sessionCwd(sessionId)
      : cwd
        ? await resolveProjectDirectory(cwd)
        : process.cwd();
    if (!root)
      throw requestError("The selected session is no longer open", 409);
    return { sessionId, cwd: root };
  }
  async function snapshot(query: unknown) {
    if (!deps.modelSettings)
      throw requestError("Model settings are unavailable on this Host", 503);
    const { sessionId, cwd } = await context(query);
    const available = sessionId
      ? (
          (await deps.runtime.snapshot(sessionId)).active?.availableModels ?? []
        ).map((model) => modelOption(model as ModelOption))
      : ((await deps.availableModels?.(false, cwd)) ?? []);
    return deps.modelSettings.read(cwd, available);
  }
  app.get("/api/model-settings", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(await snapshot(request.query));
  });
  app.patch("/api/model-settings", async (request, response) => {
    const body = z
      .object({ revision, patch: preferences })
      .strict()
      .parse(request.body);
    if (!deps.modelSettings)
      throw requestError("Model settings are unavailable", 503);
    const owner = await context(request.query);
    const before = await snapshot(request.query);
    await deps.modelSettings.savePreferences(body.revision, body.patch);
    deps.invalidateModels?.();
    response.json(await savedSnapshot(owner.cwd, before.models));
  });
  app.patch("/api/model-settings/config", async (request, response) => {
    const body = z
      .object({ revision, edit: configEdit })
      .strict()
      .parse(request.body);
    if (!deps.modelSettings)
      throw requestError("Model settings are unavailable", 503);
    const owner = await context(request.query);
    const before = await snapshot(request.query);
    await deps.modelSettings.saveConfig(
      body.revision,
      body.edit as ModelConfigEdit,
    );
    deps.invalidateModels?.();
    // Same worker, same extension overlays. A refresh failure does not undo a
    // successful file save or invite the browser to replay it.
    let warning: string | undefined;
    let models = before.models;
    try {
      // Refresh the Host runtime too, so prospective-workspace reads see the
      // saved file. Session choices still belong to that session's live worker.
      const hostModels = await deps.availableModels?.(true, owner.cwd);
      models = owner.sessionId
        ? (await deps.runtime.refreshModels(owner.sessionId)).models
        : (hostModels ?? []);
    } catch {
      warning =
        "Configuration saved. Model availability could not refresh; refresh models to retry.";
    }
    response.json(await savedSnapshot(owner.cwd, models, warning));
  });
  async function savedSnapshot(
    cwd: string,
    models: ModelOption[],
    warning?: string,
  ): Promise<import("../shared/model-settings.js").ModelSettingsWriteResult> {
    try {
      return {
        saved: true,
        snapshot: await deps.modelSettings!.read(cwd, models),
        ...(warning ? { warning } : {}),
      };
    } catch {
      return {
        saved: true,
        warning:
          "Saved to Pi. Model settings could not reload; reload settings before the next edit.",
      };
    }
  }
  type AuthEndpoint = {
    request(operation: ProviderAuthOperation): Promise<unknown>;
    isCurrent(): boolean;
    stopLogin(id: string): Promise<void>;
  };
  type OwnedAttempt = {
    state: import("../shared/model-settings.js").ProviderLoginAttempt;
    endpoint: AuthEndpoint | null;
  };
  const authOwners = new Map<string, OwnedAttempt>();
  const authAttempts = new Map<string, OwnedAttempt>();
  const authWrites = new Map<string, Promise<unknown>>();
  async function dispatchAuth(
    owner: { sessionId?: string },
    operation: ProviderAuthOperation,
    workerId?: string,
  ) {
    if (owner.sessionId) {
      if (!deps.runtime.providerAuth)
        throw requestError(
          "This session cannot manage provider credentials",
          503,
        );
      return deps.runtime.providerAuth(owner.sessionId, operation, workerId);
    }
    const auth = deps.providerAuth;
    if (!auth)
      throw requestError("Provider authentication is unavailable", 503);
    let result: unknown = null;
    switch (operation.operation) {
      case "providers":
        result = await auth.providers();
        break;
      case "start":
        result = auth.start(operation.provider, operation.type);
        break;
      case "status":
        result = auth.snapshot(operation.id);
        break;
      case "answer":
        result = auth.answer(operation.id, operation.promptId, operation.value);
        break;
      case "cancel":
        result = auth.cancel(operation.id);
        break;
      case "logout":
        await auth.logout(operation.provider);
        break;
    }
    return result;
  }
  function endpoint(owner: { sessionId?: string }): AuthEndpoint {
    const lease = owner.sessionId
      ? deps.runtime.providerAuthOwner?.(owner.sessionId)
      : null;
    if (!owner.sessionId || !lease)
      return {
        request: (operation) => dispatchAuth({}, operation),
        isCurrent: () => true,
        stopLogin: async (id) => {
          deps.providerAuth?.cancel(id);
        },
      };
    const sessionId = owner.sessionId;
    return {
      request: (operation) => dispatchAuth({ sessionId }, operation, lease.id),
      isCurrent: () =>
        deps.runtime.providerAuthOwner?.(sessionId)?.id === lease.id,
      stopLogin: lease.cancelLogin,
    };
  }
  function record(attempt: OwnedAttempt, value: unknown) {
    if (!value || typeof value !== "object" || !("status" in value)) return;
    if (attempt.state.status !== "pending" && attempt.endpoint === null) return;
    attempt.state = value as OwnedAttempt["state"];
    if (attempt.state.status !== "pending") {
      if (attempt.state.status === "completed") deps.invalidateModels?.();
      attempt.endpoint = null;
      if (authOwners.get(attempt.state.provider) === attempt)
        authOwners.delete(attempt.state.provider);
      // A response can be lost after settlement. Keep a small receipt window,
      // independently of pending credential-write ownership and worker lifetime.
      const terminal = [...authAttempts.values()].filter(
        (entry) => entry.state.status !== "pending",
      );
      for (const expired of terminal.slice(
        0,
        Math.max(0, terminal.length - 16),
      ))
        authAttempts.delete(expired.state.id);
    }
  }
  async function observe(
    attempt: OwnedAttempt,
    operation: ProviderAuthOperation,
  ) {
    const endpoint = attempt.endpoint;
    if (!endpoint) return attempt.state;
    try {
      if (endpoint.isCurrent()) {
        const value = await endpoint.request(operation);
        record(attempt, value);
        return attempt.state;
      }
    } catch (error) {
      if (endpoint.isCurrent()) throw error;
    }
    // The old worker identity is gone. Join its actual stop fence before treating
    // the login as cancelled; do not infer process death from a pane/socket state.
    await endpoint.stopLogin(attempt.state.id);
    if (attempt.state.status !== "pending") return attempt.state;
    const value = {
      ...attempt.state,
      status: "cancelled" as const,
      prompt: null,
      message: "Login cancelled because its Pi worker stopped",
    };
    record(attempt, value);
    return attempt.state;
  }
  app.post("/api/provider-auth", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const operation = authOperation.parse(
      request.body,
    ) as ProviderAuthOperation;
    if (
      operation.operation === "status" ||
      operation.operation === "answer" ||
      operation.operation === "cancel"
    ) {
      const attempt = authAttempts.get(operation.id);
      if (!attempt) {
        if (operation.operation === "cancel") {
          response.json({ result: null });
          return;
        }
        throw requestError("That login is no longer available", 404);
      }
      response.json({ result: await observe(attempt, operation) });
      return;
    }
    const owner = await context(request.query);
    const selected = endpoint(operation.operation === "logout" ? {} : owner);
    if (operation.operation === "providers") {
      response.json({ result: await selected.request(operation) });
      return;
    }
    // Global credentials share one write boundary across browser/worker/Host owners.
    const provider = operation.provider;
    const previousWrite = authWrites.get(provider) ?? Promise.resolve();
    const write = previousWrite
      .catch(() => {})
      .then(async () => {
        const previous = authOwners.get(provider);
        if (previous)
          await observe(previous, {
            operation: "cancel",
            id: previous.state.id,
          });
        const result = await selected.request(operation);
        if (operation.operation === "logout") deps.invalidateModels?.();
        if (operation.operation === "start") {
          const attempt = {
            state: result as OwnedAttempt["state"],
            endpoint: selected,
          };
          authAttempts.set(attempt.state.id, attempt);
          authOwners.set(provider, attempt);
          record(attempt, result);
        }
        return result;
      });
    authWrites.set(provider, write);
    try {
      response.json({ result: await write });
    } finally {
      if (authWrites.get(provider) === write) authWrites.delete(provider);
    }
  });
}
