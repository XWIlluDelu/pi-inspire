import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
} from "../../shared/branch-bridge-protocol.js";
import {
  PROVIDER_AUTH_LIMIT,
  PROVIDER_AUTH_SUFFIX,
  type ProviderAuthOperation,
} from "../../shared/provider-auth-bridge.js";
import {
  nativeOAuthDescriptors,
  ProviderAuthService,
} from "../provider-auth.js";

export function registerProviderAuthBridge(
  pi: ExtensionAPI,
  owner: { command: string; statusKey: string; workerId: string },
): void {
  let service: ProviderAuthService | undefined;
  let initializing: Promise<ProviderAuthService> | undefined;
  let authRuntime:
    | Awaited<
        ReturnType<
          typeof import("@earendil-works/pi-coding-agent").ModelRuntime.create
        >
      >
    | undefined;
  async function getService(
    ctx: ExtensionCommandContext,
  ): Promise<ProviderAuthService> {
    if (service) return service;
    initializing ??= (async () => {
      // The same installed public SDK as the worker. A separate auth operation
      // owner shares native storage, but takes provider methods from the live
      // registry, including extension overlays. No private session state.
      const entry = process.env.INSPIRE_PI_SDK_ENTRY;
      if (!entry) throw new Error("Missing worker SDK identity");
      const { ModelRuntime, SettingsManager, getAgentDir } = (await import(
        pathToFileURL(entry).href
      )) as typeof import("@earendil-works/pi-coding-agent");
      const runtime = await ModelRuntime.create({ refreshOnCreate: false });
      authRuntime = runtime;
      const source = {
        getProvider: (id: string) => ctx.modelRegistry.getProvider(id),
        getRegisteredProviderIds: () =>
          ctx.modelRegistry.getRegisteredProviderIds(),
        getProviders: () => {
          const ids = new Set([
            ...runtime.getProviders().map((provider) => provider.id),
            ...ctx.modelRegistry.getAll().map((model) => model.provider),
            ...ctx.modelRegistry.getRegisteredProviderIds(),
          ]);
          return [...ids].flatMap((id) => {
            const provider = source.getProvider(id);
            return provider ? [provider] : [];
          });
        },
      };
      const settings = SettingsManager.create(ctx.cwd, getAgentDir());
      service = new ProviderAuthService(
        runtime,
        () => settings.getOrCreateDeviceId(),
        source,
        await nativeOAuthDescriptors(entry),
      );
      return service;
    })().finally(() => {
      initializing = undefined;
    });
    return initializing;
  }
  pi.on("session_shutdown", () => {
    service?.close();
  });
  pi.registerCommand(`${owner.command}${PROVIDER_AUTH_SUFFIX}`, {
    description: "Internal Inspire provider authentication",
    handler: async (argument, ctx) => {
      const value = decodeBranchBridgeJson(
        argument,
        PROVIDER_AUTH_LIMIT,
      ) as ProviderAuthOperation & {
        nonce: string;
        workerId: string;
        sessionId: string;
      };
      if (
        ctx.mode !== "rpc" ||
        value.workerId !== owner.workerId ||
        value.sessionId !== ctx.sessionManager.getSessionId() ||
        typeof value.nonce !== "string" ||
        !/^[A-Za-z0-9_-]{16,200}$/.test(value.nonce)
      )
        throw new Error("invalid provider authentication owner");
      let result: unknown = null;
      let error: string | undefined;
      try {
        const auth = await getService(ctx);
        if (value.operation === "providers" || value.operation === "start")
          await authRuntime!.refresh({ allowNetwork: false });
        result = await auth.request(value);
      } catch {
        error =
          "Pi could not complete this authentication operation. Reload its status before retrying.";
      }
      ctx.ui.setStatus(
        `${owner.statusKey}${PROVIDER_AUTH_SUFFIX}`,
        encodeBranchBridgeJson(
          {
            nonce: value.nonce,
            workerId: owner.workerId,
            sessionId: value.sessionId,
            result,
            ...(error ? { error } : {}),
          },
          PROVIDER_AUTH_LIMIT,
        ),
      );
    },
  });
}
