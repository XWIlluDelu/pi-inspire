import type {
  ProviderLoginAttempt,
  ProviderLoginOption,
} from "./model-settings.js";
export const PROVIDER_AUTH_SUFFIX = "_auth";
export const PROVIDER_AUTH_LIMIT = 262_144;
export type ProviderAuthOperation = import("zod").input<
  typeof import("./host-endpoints.js").hostEndpoints.providerAuth.schemas.body
>;
export type ProviderAuthResult =
  | ProviderLoginOption[]
  | ProviderLoginAttempt
  | null;
