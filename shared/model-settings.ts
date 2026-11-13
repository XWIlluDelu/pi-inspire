import { z } from "zod";
import type { PiCommand } from "./commands.js";
import {
  configurationField,
  fieldSchemas,
  nullableEdit,
  storedConfigurationField,
} from "./configuration-fields.js";
import {
  type ModelIdentity,
  type ModelOption,
  type NewSessionDefaults,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./contracts.js";

export interface ModelSettingsOwner {
  sessionId?: string;
  cwd?: string;
}
export interface ModelSettingsDestination {
  query?: string;
  focus?: "credentials" | "common";
  owner?: ModelSettingsOwner;
}

export interface CommonModelOption extends ModelIdentity {
  thinkingLevel?: ThinkingLevel;
}
export const modelThinkingPreferencesSchema = z.object({
  defaultLevel: z.enum(THINKING_LEVELS).optional(),
  byModel: z.record(z.string(), z.enum(THINKING_LEVELS)),
});
export type ModelThinkingPreferences = z.infer<
  typeof modelThinkingPreferencesSchema
>;

/** The same settings precedence Pi uses before capability clamping. */
export function modelSwitchThinkingLevel(
  model: ModelIdentity,
  preferences: ModelThinkingPreferences | undefined,
  current: ThinkingLevel,
): ThinkingLevel {
  return (
    preferences?.byModel[`${model.provider}/${model.id}`] ??
    preferences?.defaultLevel ??
    current
  );
}

export interface ModelCatalogResponse {
  models: ModelOption[];
  /** Registered extension commands observable before starting a session. */
  commands?: PiCommand[];
  defaults?: NewSessionDefaults;
  /** Addressed source selection, requested only for pending New inheritance. */
  selection?: NewSessionDefaults;
  thinkingPreferences?: ModelThinkingPreferences;
  commonModels?: CommonModelOption[];
  warning?: string;
}
export interface PiModelPreferences {
  defaultModel: ModelIdentity | null;
  defaultThinkingLevel: ThinkingLevel | null;
  enabledModels: string[];
}
export type ModelDeclaration = z.infer<typeof modelDeclarationSchema>;
export type ProviderDeclaration = z.infer<typeof providerDeclarationSchema> & {
  id: string;
  apiKeyConfigured: boolean;
  models: ModelDeclaration[];
};
export interface ModelSettingsSnapshot {
  settingsRevision: string;
  configRevision: string;
  saved: PiModelPreferences;
  effective: PiModelPreferences;
  projectOverrides: string[];
  providers: ProviderDeclaration[];
  /** Native provider API inheritance metadata, never model-selection candidates. */
  nativeApiProviders?: string[];
  models: ModelOption[];
  commonModels: CommonModelOption[];
  savedCommonEntries: Array<{ pattern: string; models: CommonModelOption[] }>;
  settingsError?: string;
  /** Project overrides failed to load; global preferences are still editable. */
  projectSettingsError?: string;
  configError?: string;
  modelDiscoveryFailed?: true;
  modelsWarning?: string;
}
const token = z.string().min(1).max(256);
const modelId = z.string().min(1).max(512);
export const modelPreferencesPatchSchema = z
  .object({
    defaultModel: nullableEdit(z.object({ provider: token, id: modelId })),
    defaultThinkingLevel: nullableEdit(z.enum(THINKING_LEVELS)),
    enabledModels: z.array(z.string().min(1).max(512)).max(512).optional(),
  })
  .strict();
export type ModelPreferencesPatch = z.infer<typeof modelPreferencesPatchSchema>;
export interface ModelSettingsWriteResult {
  saved: true;
  snapshot?: ModelSettingsSnapshot;
  warning?: string;
}

const baseUrl = storedConfigurationField(
  z.string(),
  {
    label: "Base URL",
    placeholder: "https://api.example.com/v1",
    maxLength: 4_096,
  },
  z.string().max(4_096),
);
const api = storedConfigurationField(
  z.string(),
  { label: "API type", maxLength: 256 },
  token,
);
const name = storedConfigurationField(
  z.string(),
  { label: "Display name", placeholder: "Optional", maxLength: 512 },
  z.string().max(512),
);
const type = z.string().optional().catch(undefined);
const input = z
  .array(z.unknown())
  .transform((items) =>
    items.filter((item): item is string => typeof item === "string"),
  );
const tokenCount = (label: string) =>
  storedConfigurationField(z.number(), {
    label,
    type: "number",
    placeholder: "Pi default",
    step: "any",
  });
const apiKey = configurationField(z.string().max(16_384), {
  label: "API key",
  type: "password",
  maxLength: 16_384,
});
export const providerDeclarationFields = { baseUrl, api };
export const providerApiKey = apiKey.control;
export const modelDeclarationFields = {
  baseUrl,
  api,
  name,
  contextWindow: tokenCount("Context window"),
  maxTokens: tokenCount("Maximum output tokens"),
};
export const providerDeclarationSchema = z.object(
  fieldSchemas(providerDeclarationFields, "stored"),
);
const providerValues = z.strictObject({
  ...fieldSchemas(providerDeclarationFields, "schema"),
  apiKey: apiKey.schema,
});
const modelValues = z.strictObject({
  ...fieldSchemas(modelDeclarationFields, "schema"),
  id: modelId,
  reasoning: nullableEdit(z.boolean()),
  input: nullableEdit(z.array(z.string().max(100)).max(8)),
  type: nullableEdit(token),
});
export const modelDeclarationSchema = z.object({
  ...fieldSchemas(modelDeclarationFields, "stored"),
  id: z.string(),
  reasoning: z.boolean().optional().catch(undefined),
  input: input.optional().catch(undefined),
  type,
});
export const modelConfigEditSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("provider"),
    id: token,
    values: providerValues,
  }),
  z.strictObject({ kind: z.literal("remove-provider"), id: token }),
  z.strictObject({
    kind: z.literal("model"),
    provider: token,
    originalId: z.string().max(512).optional(),
    originalType: token.optional(),
    values: modelValues,
  }),
  z.strictObject({
    kind: z.literal("remove-model"),
    provider: token,
    id: modelId,
    type: token.optional(),
  }),
]);
export type ModelConfigEdit = z.infer<typeof modelConfigEditSchema>;

export type ProviderAuthType = "api_key" | "oauth";
export interface ProviderLoginMethod {
  type: ProviderAuthType;
  label: string;
  remoteHelp?: string;
}
export interface ProviderLoginOption {
  id: string;
  name: string;
  methods: ProviderLoginMethod[];
  stored: ProviderAuthType | null;
}
export interface LoginPrompt {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{
    id: string;
    label: string;
    description?: string;
    remoteHelp?: string;
  }>;
}
export interface LoginEvent {
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  userCode?: string;
  links?: Array<{ url: string; label?: string }>;
}
export interface ProviderLoginAttempt {
  id: string;
  provider: string;
  type: ProviderAuthType;
  status: "pending" | "completed" | "cancelled" | "failed";
  events: LoginEvent[];
  prompt: LoginPrompt | null;
  message?: string;
}
