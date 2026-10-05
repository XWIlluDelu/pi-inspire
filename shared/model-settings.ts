import type {
  ModelIdentity,
  ModelOption,
  NewSessionDefaults,
  ThinkingLevel,
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
export interface ModelCatalogResponse {
  models: ModelOption[];
  defaults?: NewSessionDefaults;
  /** Addressed source selection, requested only for pending New inheritance. */
  selection?: NewSessionDefaults;
  commonModels?: CommonModelOption[];
  warning?: string;
}
export interface PiModelPreferences {
  defaultModel: ModelIdentity | null;
  defaultThinkingLevel: ThinkingLevel | null;
  enabledModels: string[];
}
export interface ModelDeclaration {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  type?: string;
  advancedFields: string[];
}
export interface ProviderDeclaration {
  id: string;
  baseUrl?: string;
  api?: string;
  apiKeyConfigured: boolean;
  models: ModelDeclaration[];
  advancedFields: string[];
}
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
  configError?: string;
}
export type ModelPreferencesPatch = Partial<PiModelPreferences>;
export interface ModelSettingsWriteResult {
  saved: true;
  snapshot?: ModelSettingsSnapshot;
  warning?: string;
}

export type ModelConfigEdit =
  | {
      kind: "provider";
      id: string;
      values: {
        baseUrl?: string | null;
        api?: string | null;
        apiKey?: string | null;
      };
    }
  | { kind: "remove-provider"; id: string }
  | {
      kind: "model";
      provider: string;
      originalId?: string;
      originalType?: string;
      values: {
        id: string;
        name?: string | null;
        api?: string | null;
        baseUrl?: string | null;
        reasoning?: boolean | null;
        input?: string[] | null;
        contextWindow?: number | null;
        maxTokens?: number | null;
        type?: string | null;
      };
    }
  | { kind: "remove-model"; provider: string; id: string; type?: string };

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
