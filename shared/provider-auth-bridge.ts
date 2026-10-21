import type {
  ProviderAuthType,
  ProviderLoginAttempt,
  ProviderLoginOption,
} from "./model-settings.js";
export const PROVIDER_AUTH_SUFFIX = "_auth";
export const PROVIDER_AUTH_LIMIT = 262_144;
export type ProviderAuthOperation =
  | { operation: "providers" }
  | { operation: "start"; provider: string; type: ProviderAuthType }
  | { operation: "status"; id: string }
  | { operation: "answer"; id: string; promptId: string; value: string }
  | { operation: "cancel"; id: string }
  | { operation: "logout"; provider: string };
export type ProviderAuthResult =
  | ProviderLoginOption[]
  | ProviderLoginAttempt
  | null;
