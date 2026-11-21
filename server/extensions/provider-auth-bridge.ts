import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  PROVIDER_AUTH_LIMIT,
  PROVIDER_AUTH_SUFFIX,
  type ProviderAuthOperation,
} from "../../shared/provider-auth-bridge.js";
import {
  nativeOAuthDescriptors,
  ProviderAuthService,
} from "../provider-auth.js";
import type { BranchBridgeIdentity } from "../runtime-slot.js";
import { registerWorkerStatusCommand } from "./worker-status-command.js";

export function registerProviderAuthBridge(
  pi: ExtensionAPI,
  owner: BranchBridgeIdentity,
): void {
  let closed = false;
  let service: ProviderAuthService | undefined;
  let initializing: Promise<ProviderAuthService> | undefined;
  async function getService(
    ctx: ExtensionCommandContext,
  ): Promise<ProviderAuthService> {
    if (closed) throw new Error("Provider authentication owner retired");
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
      const descriptors = await nativeOAuthDescriptors(entry);
      // Reload may retire this extension while its lazy SDK work is pending.
      if (closed) throw new Error("Provider authentication owner retired");
      service = new ProviderAuthService(
        runtime,
        () => settings.getOrCreateDeviceId(),
        source,
        descriptors,
      );
      return service;
    })().finally(() => {
      initializing = undefined;
    });
    return initializing;
  }
  pi.on("session_shutdown", () => {
    closed = true;
    service?.close();
  });
  registerWorkerStatusCommand(
    pi,
    owner,
    {
      suffix: PROVIDER_AUTH_SUFFIX,
      description: "provider authentication",
      argumentLimit: PROVIDER_AUTH_LIMIT,
      resultLimit: PROVIDER_AUTH_LIMIT,
    },
    async (request, ctx, emit) => {
      let result: unknown = null;
      let error: string | undefined;
      try {
        const auth = await getService(ctx);
        if (closed) throw new Error("Provider authentication owner retired");
        result = await auth.request(request as ProviderAuthOperation);
      } catch {
        error =
          "Pi could not complete this authentication operation. Reload its status before retrying.";
      }
      emit({ result, ...(error ? { error } : {}) });
    },
  );
}
