import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  LoginEvent,
  ProviderAuthType,
  ProviderLoginAttempt,
  ProviderLoginOption,
} from "../shared/model-settings.js";
import { requestError } from "./request-error.js";

type Interaction = Parameters<ModelRuntime["login"]>[2];
type AuthEvent = Parameters<Interaction["notify"]>[0];
type AuthPrompt = Parameters<Interaction["prompt"]>[0];
type Provider = NonNullable<ReturnType<ModelRuntime["getProvider"]>>;
type OAuthDescriptor = Pick<
  NonNullable<Provider["auth"]["oauth"]>,
  "name" | "loginLabel" | "isSubscription"
>;
type RemoteHelp = (option?: string) => string | undefined;

/** Passive native descriptors: no user config, credentials or availability pass. */
export async function nativeOAuthDescriptors(
  sdkEntry: string,
): Promise<ReadonlyMap<string, OAuthDescriptor>> {
  const { ModelRuntime } = (await import(
    pathToFileURL(sdkEntry).href
  )) as typeof import("@earendil-works/pi-coding-agent");
  const native = await ModelRuntime.create({
    modelsPath: null,
    credentials: {
      read: async () => undefined,
      modify: async () => undefined,
      delete: async () => undefined,
      list: async () => [],
    },
    refreshOnCreate: false,
  });
  return new Map(
    native.getProviders().flatMap((provider) => {
      const oauth = provider.auth.oauth;
      return oauth
        ? [
            [
              provider.id,
              {
                name: oauth.name,
                loginLabel: oauth.loginLabel,
                isSubscription: oauth.isSubscription,
              },
            ] as const,
          ]
        : [];
    }),
  );
}

const DEVICE_HELP =
  "Open the sign-in link on this device and enter the displayed code.";
const REDIRECT_HELP =
  "Open the sign-in link on this device, then paste the final redirect URL here.";
const COPY_HELP =
  "Open the sign-in link on this device, then paste the authorization code shown there.";
/** Apply only after matching the known native login implementation. A
 * device_code event independently establishes remote instructions for any provider. */
function remoteLoginHelp(
  provider: string,
  option?: string,
): string | undefined {
  if (provider === "anthropic")
    return option === "copy_code" ? COPY_HELP : undefined;
  if (provider === "openai-codex")
    return option === "device_code"
      ? DEVICE_HELP
      : option === "browser"
        ? REDIRECT_HELP
        : undefined;
  if (option !== undefined) return undefined;
  if (["github-copilot", "kimi-coding", "xai"].includes(provider))
    return DEVICE_HELP;
  if (["openrouter", "openai"].includes(provider)) return REDIRECT_HELP;
  return undefined;
}
function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? value.slice(0, 16_384)
      : undefined;
  } catch {
    return undefined;
  }
}
function eventProjection(event: AuthEvent): LoginEvent {
  if (event.type === "device_code")
    return {
      type: event.type,
      url: safeUrl(event.verificationUri),
      userCode: event.userCode.slice(0, 256),
    };
  if (event.type === "auth_url")
    return {
      type: event.type,
      url: safeUrl(event.url),
      message: event.instructions
        ?.replace("A browser window should open. ", "")
        .slice(0, 2_000),
    };
  return {
    type: event.type,
    message: event.message.slice(0, 2_000),
    ...(event.type === "info" && event.links
      ? {
          links: event.links.flatMap((link) => {
            const url = safeUrl(link.url);
            return url ? [{ url, label: link.label?.slice(0, 256) }] : [];
          }),
        }
      : {}),
  };
}
interface Attempt {
  state: ProviderLoginAttempt;
  controller: AbortController;
  remoteHelp?: RemoteHelp;
  pending?: {
    id: string;
    resolve: (value: string) => void;
    options?: readonly { id: string }[];
    dispose: () => void;
  };
  timer: ReturnType<typeof setTimeout>;
}
export class ProviderAuthService {
  private readonly attempts = new Map<string, Attempt>();
  private readonly owners = new Map<string, string>();
  constructor(
    private readonly runtime: Pick<
      ModelRuntime,
      | "getProviders"
      | "getProvider"
      | "getRegisteredProviderIds"
      | "listCredentials"
      | "login"
      | "logout"
      | "registerNativeProvider"
    >,
    private readonly getDeviceId?: () => string,
    private readonly providerSource?: Pick<
      ModelRuntime,
      "getProviders" | "getProvider" | "getRegisteredProviderIds"
    >,
    private readonly nativeOAuth: ReadonlyMap<
      string,
      OAuthDescriptor
    > = new Map(),
  ) {}
  private remoteHelp(provider: Provider): RemoteHelp | undefined {
    const id = provider.id;
    const oauth = provider.auth.oauth;
    const native = this.nativeOAuth.get(id);
    const source = this.providerSource ?? this.runtime;
    return !source.getRegisteredProviderIds().includes(id) &&
      oauth &&
      native &&
      oauth.name === native.name &&
      oauth.loginLabel === native.loginLabel &&
      oauth.isSubscription === native.isSubscription
      ? (option) => remoteLoginHelp(id, option)
      : undefined;
  }
  async providers(): Promise<ProviderLoginOption[]> {
    const stored = new Map(
      (await this.runtime.listCredentials()).map((value) => [
        value.providerId,
        value.type,
      ]),
    );
    const providers = (this.providerSource ?? this.runtime)
      .getProviders()
      .map((provider) => {
        const remoteHelp = this.remoteHelp(provider)?.();
        return {
          id: provider.id,
          name: provider.name,
          stored: stored.get(provider.id) ?? null,
          methods: [
            ...(provider.auth.apiKey?.login
              ? [{ type: "api_key" as const, label: provider.auth.apiKey.name }]
              : []),
            ...(provider.auth.oauth
              ? [
                  {
                    type: "oauth" as const,
                    label:
                      provider.auth.oauth.loginLabel ??
                      provider.auth.oauth.name,
                    ...(remoteHelp ? { remoteHelp } : {}),
                  },
                ]
              : []),
          ],
        };
      });
    // Stored entries remain removable after a custom provider was removed.
    for (const [id, type] of stored)
      if (!providers.some((provider) => provider.id === id))
        providers.push({ id, name: id, stored: type, methods: [] });
    return providers.sort((a, b) => a.name.localeCompare(b.name));
  }
  start(provider: string, type: ProviderAuthType): ProviderLoginAttempt {
    const declaration = (this.providerSource ?? this.runtime).getProvider(
      provider,
    );
    const auth = declaration?.auth;
    if (
      !declaration ||
      (type === "oauth" ? !auth?.oauth : !auth?.apiKey?.login)
    )
      throw requestError("This provider does not offer that login method", 400);
    // Only the selected live overlay is copied. Native registration refreshes
    // availability, so copying the entire builtin catalog would cause a fanout.
    if (this.runtime.getProvider(provider) !== declaration)
      this.runtime.registerNativeProvider(declaration);
    const previous = this.owners.get(provider);
    if (previous) this.cancel(previous);
    // Retain cancellation receipts for clients still observing an old attempt.
    // Bound retained receipts without retiring any pending native flow.
    for (const [id, attempt] of this.attempts) {
      if (this.attempts.size < 16) break;
      if (attempt.state.status !== "pending") {
        clearTimeout(attempt.timer);
        this.attempts.delete(id);
      }
    }
    if (this.attempts.size >= 16)
      throw requestError("Finish or cancel a pending login first", 409);
    const id = randomUUID();
    const attempt: Attempt = {
      state: {
        id,
        provider,
        type,
        status: "pending",
        events: [],
        prompt: null,
      },
      controller: new AbortController(),
      remoteHelp: type === "oauth" ? this.remoteHelp(declaration) : undefined,
      timer: setTimeout(() => this.cancel(id), 10 * 60_000),
    };
    this.attempts.set(id, attempt);
    this.owners.set(provider, id);
    const signal = attempt.controller.signal;
    const login = this.runtime.login as typeof this.runtime.login &
      ((
        provider: string,
        type: ProviderAuthType,
        interaction: Parameters<ModelRuntime["login"]>[2],
        options?: { getDeviceId: () => string },
      ) => ReturnType<ModelRuntime["login"]>);
    void login
      .call(
        this.runtime,
        provider,
        type,
        {
          signal,
          notify: (event) => {
            if (signal.aborted || this.owners.get(provider) !== id) return;
            attempt.state.events = [
              ...attempt.state.events,
              eventProjection(event),
            ].slice(-12);
          },
          prompt: (prompt) => this.prompt(attempt, prompt),
        },
        this.getDeviceId ? { getDeviceId: this.getDeviceId } : undefined,
      )
      .then(
        () => {
          if (signal.aborted || this.owners.get(provider) !== id) return;
          attempt.state.status = "completed";
          attempt.state.message =
            type === "api_key" ? "API key saved." : "Login complete.";
        },
        (error: unknown) => {
          if (signal.aborted || this.owners.get(provider) !== id) return;
          attempt.state.status = "failed";
          // Native OAuth errors can contain token responses; never forward/log them.
          attempt.state.message =
            error instanceof Error &&
            error.name === "CredentialSynchronizationError"
              ? "Credentials were saved, but model availability could not refresh. Refresh models to retry."
              : "Pi could not complete login. Check the input and try again.";
        },
      )
      .finally(() => {
        clearTimeout(attempt.timer);
        attempt.pending?.dispose();
        attempt.pending = undefined;
        attempt.state.prompt = null;
      });
    return this.snapshot(id);
  }
  private prompt(attempt: Attempt, prompt: AuthPrompt): Promise<string> {
    const signal = prompt.signal
      ? AbortSignal.any([attempt.controller.signal, prompt.signal])
      : attempt.controller.signal;
    if (signal.aborted)
      return Promise.reject(new DOMException("Cancelled", "AbortError"));
    if (attempt.pending)
      return Promise.reject(
        new Error("Concurrent login prompts are not supported"),
      );
    const id = randomUUID();
    attempt.state.prompt = {
      id,
      type: prompt.type,
      message: prompt.message.slice(0, 2_000),
      ...("placeholder" in prompt && prompt.placeholder
        ? { placeholder: prompt.placeholder.slice(0, 512) }
        : {}),
      ...(prompt.type === "select"
        ? {
            options: prompt.options.map((option) => ({
              id: option.id,
              label: option.label,
              description: option.description,
              ...(attempt.remoteHelp?.(option.id)
                ? { remoteHelp: attempt.remoteHelp(option.id) }
                : {}),
            })),
          }
        : {}),
    };
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (attempt.pending?.id !== id) return;
        attempt.pending.dispose();
        attempt.pending = undefined;
        attempt.state.prompt = null;
        reject(new DOMException("Cancelled", "AbortError"));
      };
      attempt.pending = {
        id,
        resolve,
        options: prompt.type === "select" ? prompt.options : undefined,
        dispose: () => signal.removeEventListener("abort", abort),
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  snapshot(id: string): ProviderLoginAttempt {
    const attempt = this.attempts.get(id);
    if (!attempt)
      throw requestError("That login expired. Start login again.", 404);
    return structuredClone(attempt.state);
  }
  answer(id: string, promptId: string, value: string): ProviderLoginAttempt {
    const attempt = this.attempts.get(id);
    const pending = attempt?.pending;
    if (
      !attempt ||
      attempt.state.status !== "pending" ||
      !pending ||
      pending.id !== promptId ||
      this.owners.get(attempt.state.provider) !== id
    )
      throw requestError("That login step is no longer current", 409);
    if (
      pending.options &&
      !pending.options.some((option) => option.id === value)
    )
      throw requestError("Choose one of Pi's login methods", 400);
    pending.dispose();
    attempt.pending = undefined;
    attempt.state.prompt = null;
    pending.resolve(value);
    return this.snapshot(id);
  }
  cancel(id: string): ProviderLoginAttempt | null {
    const attempt = this.attempts.get(id);
    if (!attempt) return null;
    if (attempt.state.status === "pending") {
      attempt.state.status = "cancelled";
      attempt.state.prompt = null;
      attempt.state.message = "Login cancelled.";
      attempt.controller.abort();
      clearTimeout(attempt.timer);
    }
    return this.snapshot(id);
  }
  async logout(provider: string): Promise<void> {
    const owner = this.owners.get(provider);
    if (owner) this.cancel(owner);
    this.owners.delete(provider);
    try {
      await this.runtime.logout(provider);
    } catch {
      throw requestError(
        "Pi could not confirm removal. Reload credential status before retrying.",
        409,
      );
    }
  }
  close(): void {
    for (const id of this.attempts.keys()) this.cancel(id);
  }
}
