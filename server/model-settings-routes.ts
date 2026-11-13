import type { Express } from "express";
import type { ModelOption } from "../shared/contracts.js";
import { hostEndpoints as routes } from "../shared/host-endpoints.js";
import type { ModelSettingsOwner } from "../shared/model-settings.js";
import type {
  ProviderAuthOperation,
  ProviderAuthResult,
} from "../shared/provider-auth-bridge.js";
import { savedConfiguration } from "./configuration-file.js";
import { jsonRoute } from "./json-route.js";
import { modelOption } from "./model-catalog.js";
import type { ModelMetadataCatalog } from "./model-metadata.js";
import type { ModelSettingsService } from "./model-settings.js";
import { resolveProjectDirectory } from "./paths.js";
import type { ProviderAuthService } from "./provider-auth.js";
import { requestError } from "./request-error.js";
import type { RuntimeController } from "./runtime.js";

export function registerModelSettingsRoutes(
  app: Express,
  deps: {
    runtime: Pick<
      RuntimeController,
      | "sessionCwd"
      | "refreshModels"
      | "snapshot"
      | "providerAuth"
      | "providerAuthOwner"
    >;
    modelSettings?: ModelSettingsService;
    providerAuth?: ProviderAuthService;
    invalidateModels?: () => void;
    modelMetadata?: ModelMetadataCatalog["read"];
  },
): void {
  async function context({ sessionId, cwd }: ModelSettingsOwner) {
    const root = sessionId
      ? deps.runtime.sessionCwd(sessionId)
      : cwd
        ? await resolveProjectDirectory(cwd)
        : process.cwd();
    if (!root)
      throw requestError("The selected session is no longer open", 409);
    return { sessionId, cwd: root };
  }
  async function modelsFor(
    owner: { sessionId?: string; cwd: string },
    refresh = false,
  ): Promise<{
    models: ModelOption[];
    modelsWarning?: string;
    modelDiscoveryFailed?: true;
  }> {
    try {
      if (!owner.sessionId) {
        const metadata = await deps.modelMetadata?.(owner.cwd, refresh);
        return {
          models: metadata?.models ?? [],
          modelsWarning: metadata?.warning,
        };
      }
      if (refresh) {
        const { models, warning } = await deps.runtime.refreshModels(
          owner.sessionId,
        );
        return {
          models,
          modelsWarning: warning,
        };
      }
      const snapshot = await deps.runtime.snapshot(owner.sessionId);
      return {
        models: (snapshot.active?.availableModels ?? []).map((model) =>
          modelOption(model as ModelOption),
        ),
      };
    } catch {
      return {
        models: [],
        modelDiscoveryFailed: true,
        modelsWarning:
          "Model availability could not load. Saved configuration is still editable; refresh models to retry.",
      };
    }
  }
  const configuration = () => {
    if (!deps.modelSettings)
      throw requestError("Model settings are unavailable on this Host", 503);
    return deps.modelSettings;
  };
  async function readSettings(
    service: ModelSettingsService,
    owner: Awaited<ReturnType<typeof context>>,
    refresh = false,
  ) {
    const { models, ...discovery } = await modelsFor(owner, refresh);
    return {
      ...(await service.read(owner.cwd, models)),
      ...discovery,
    };
  }
  async function save(
    query: ModelSettingsOwner,
    apply: (service: ModelSettingsService, cwd: string) => Promise<void>,
    refresh: boolean,
  ) {
    const service = configuration();
    const owner = await context(query);
    await apply(service, owner.cwd);
    deps.invalidateModels?.();
    return savedConfiguration(
      () => readSettings(service, owner, refresh),
      "Saved to Pi. Model settings could not reload; reload settings before the next edit.",
    );
  }
  jsonRoute(
    app,
    routes.modelSettings,
    async ({ query: { refresh, ...owner } }) =>
      readSettings(configuration(), await context(owner), refresh === "1"),
  );
  jsonRoute(app, routes.saveModelPreferences, ({ query, body }) =>
    save(
      query,
      (service) => service.savePreferences(body.revision, body.patch),
      false,
    ),
  );
  jsonRoute(app, routes.editModelConfig, ({ query, body }) =>
    save(
      query,
      (service, cwd) => service.saveConfig(cwd, body.revision, body.edit),
      true,
    ),
  );
  type AuthEndpoint = {
    request(operation: ProviderAuthOperation): Promise<ProviderAuthResult>;
    isCurrent(): boolean;
    stopLogin(id: string): Promise<void>;
  };
  type OwnedAttempt = {
    state: import("../shared/model-settings.js").ProviderLoginAttempt;
    endpoint: AuthEndpoint | null;
  };
  const authOwners = new Map<string, OwnedAttempt>();
  const authAttempts = new Map<string, OwnedAttempt>();
  const authWrites = new Map<string, Promise<ProviderAuthResult>>();
  async function dispatchAuth(
    owner: { sessionId?: string },
    operation: ProviderAuthOperation,
    workerId?: string,
  ) {
    if (owner.sessionId)
      return deps.runtime.providerAuth(owner.sessionId, operation, workerId);
    if (!deps.providerAuth)
      throw requestError("Provider authentication is unavailable", 503);
    return deps.providerAuth.request(operation);
  }
  function endpoint(owner: { sessionId?: string }): AuthEndpoint {
    const lease = owner.sessionId
      ? deps.runtime.providerAuthOwner(owner.sessionId)
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
        deps.runtime.providerAuthOwner(sessionId)?.id === lease.id,
      stopLogin: lease.cancelLogin,
    };
  }
  function record(attempt: OwnedAttempt, value: ProviderAuthResult) {
    if (!value || Array.isArray(value)) return;
    if (attempt.state.status !== "pending" && attempt.endpoint === null) return;
    attempt.state = value;
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
  jsonRoute(app, routes.providerAuth, async ({ query, body: operation }) => {
    if (
      operation.operation === "status" ||
      operation.operation === "answer" ||
      operation.operation === "cancel"
    ) {
      const attempt = authAttempts.get(operation.id);
      if (!attempt) {
        if (operation.operation === "cancel") return { result: null };
        throw requestError("That login is no longer available", 404);
      }
      return { result: await observe(attempt, operation) };
    }
    const owner = await context(query);
    const selected = endpoint(operation.operation === "logout" ? {} : owner);
    if (operation.operation === "providers")
      return { result: await selected.request(operation) };
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
          if (!result || Array.isArray(result))
            throw requestError("Pi returned no authentication attempt", 502);
          const attempt = { state: result, endpoint: selected };
          authAttempts.set(attempt.state.id, attempt);
          authOwners.set(provider, attempt);
          record(attempt, result);
        }
        return result;
      });
    authWrites.set(provider, write);
    try {
      return { result: await write };
    } finally {
      if (authWrites.get(provider) === write) authWrites.delete(provider);
    }
  });
}
