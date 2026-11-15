import { join } from "node:path";
import type { ModelRuntime as NativeModelRuntime } from "@earendil-works/pi-coding-agent";
import { type ModelOption, THINKING_LEVELS } from "../shared/contracts.js";
import { isJsonRecord } from "../shared/json-record.js";
import {
  type ModelConfigEdit,
  type ModelPreferencesPatch,
  type ModelSettingsSnapshot,
  modelDeclarationSchema,
  type PiModelPreferences,
  type ProviderDeclaration,
  providerDeclarationSchema,
} from "../shared/model-settings.js";
import {
  applyConfigurationPatch,
  editConfigurationDocument,
  readConfigurationDocument,
} from "./configuration-file.js";
import {
  readNativeModelSettings,
  validateModelConfig,
} from "./model-metadata.js";
import {
  getAgentDir,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
} from "./pi-runtime.js";
import { requestError } from "./request-error.js";

type JsonObject = Record<string, unknown>;
const settingsDocument = {
  invalid: "settings.json is invalid. Repair the file before saving.",
};
const modelsDocument = {
  invalid: "models.json is invalid. Repair the file before saving.",
  comments: true,
};
const invalidDeclaration =
  "Pi rejected this declaration. Check its endpoint, API, model fields and extensions.";
function preferences(value: JsonObject): PiModelPreferences {
  return {
    defaultModel:
      typeof value.defaultProvider === "string" &&
      typeof value.defaultModel === "string"
        ? { provider: value.defaultProvider, id: value.defaultModel }
        : null,
    defaultThinkingLevel: THINKING_LEVELS.includes(
      value.defaultThinkingLevel as never,
    )
      ? (value.defaultThinkingLevel as PiModelPreferences["defaultThinkingLevel"])
      : null,
    enabledModels: Array.isArray(value.enabledModels)
      ? value.enabledModels.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  };
}
function declarationProjection(config: JsonObject): ProviderDeclaration[] {
  return Object.entries(
    isJsonRecord(config.providers) ? config.providers : {},
  ).flatMap(([id, provider]) => {
    if (!isJsonRecord(provider)) return [];
    return [
      {
        id,
        ...providerDeclarationSchema.parse(provider),
        apiKeyConfigured: provider.apiKey !== undefined,
        models: Array.isArray(provider.models)
          ? provider.models.flatMap((value) => {
              const model = modelDeclarationSchema.safeParse(value);
              return model.success ? [model.data] : [];
            })
          : [],
      },
    ];
  });
}

function applyModelEdit(
  current: JsonObject,
  edit: ModelConfigEdit,
): JsonObject {
  const { providers = {} } = current;
  if (!isJsonRecord(providers))
    throw requestError("models.json providers must be an object", 409);
  const id = "provider" in edit ? edit.provider : edit.id;
  const updated =
    edit.kind === "remove-provider"
      ? null
      : editProvider(Object.hasOwn(providers, id) ? providers[id] : {}, edit);
  return {
    ...current,
    providers: applyConfigurationPatch(providers, { [id]: updated }),
  };
}

export async function commonModelOptions(
  patterns: string[],
  models: ModelOption[],
) {
  if (!patterns.length) return [];
  const runtime = {
    getAvailable: async () => models,
  } as unknown as NativeModelRuntime;
  return (
    await resolveModelScopeWithDiagnostics(patterns, runtime)
  ).scopedModels.map(({ model, thinkingLevel }) => ({
    provider: model.provider,
    id: model.id,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  }));
}

export class ModelSettingsService {
  private nativeApiProviders: Promise<string[]> | undefined;
  private readonly settingsFile: { path: string };
  private readonly modelsFile: { path: string };

  constructor(private readonly agentDir = getAgentDir()) {
    this.settingsFile = { path: join(agentDir, "settings.json") };
    this.modelsFile = { path: join(agentDir, "models.json") };
  }

  async readCatalogPreferences(cwd: string) {
    const { effective, thinkingPreferences } = await readNativeModelSettings(
      cwd,
      this.agentDir,
    );
    return {
      enabledModelPatterns: preferences(effective).enabledModels,
      thinkingPreferences,
    };
  }
  private readNativeApiProviders(): Promise<string[]> {
    return (this.nativeApiProviders ??= ModelRuntime.create({
      modelsPath: null,
      credentials: {
        read: async () => undefined,
        modify: async () => undefined,
        delete: async () => undefined,
        list: async () => [],
      },
      refreshOnCreate: false,
    }).then((runtime) =>
      runtime
        .getProviders()
        .filter((provider) => provider.getModels().length > 0)
        .map((provider) => provider.id),
    ));
  }
  async read(
    cwd: string,
    models: ModelOption[],
  ): Promise<ModelSettingsSnapshot> {
    const [settings, modelsFile, native] = await Promise.all([
      readConfigurationDocument(this.settingsFile, settingsDocument),
      readConfigurationDocument(this.modelsFile, modelsDocument),
      readNativeModelSettings(cwd, this.agentDir),
    ]);
    const effective = preferences(native.effective);
    const settingsError =
      settings.error ??
      (native.globalError
        ? "Global Pi settings could not be loaded. Repair settings.json before saving."
        : undefined);
    const projectSettingsError = native.projectError
      ? "Project settings could not be loaded. Showing global defaults; global settings remain editable. Repair this project's .pi/settings.json to restore its overrides."
      : undefined;
    const saved = preferences(settings.value);
    return {
      settingsRevision: settings.revision,
      configRevision: modelsFile.revision,
      saved,
      effective,
      projectOverrides: native.projectOverrides,
      providers: declarationProjection(modelsFile.value),
      nativeApiProviders: await this.readNativeApiProviders(),
      models,
      commonModels: await commonModelOptions(effective.enabledModels, models),
      savedCommonEntries: await Promise.all(
        saved.enabledModels.map(async (pattern) => ({
          pattern,
          models: await commonModelOptions([pattern], models),
        })),
      ),
      ...(settingsError ? { settingsError } : {}),
      ...(projectSettingsError ? { projectSettingsError } : {}),
      ...(modelsFile.error ? { configError: modelsFile.error } : {}),
    };
  }
  async savePreferences(
    expectedRevision: string,
    patch: ModelPreferencesPatch,
  ): Promise<void> {
    return editConfigurationDocument(
      { ...this.settingsFile, expectedRevision },
      settingsDocument,
      (current) =>
        applyConfigurationPatch(current, {
          defaultProvider:
            patch.defaultModel === null ? null : patch.defaultModel?.provider,
          defaultModel:
            patch.defaultModel === null ? null : patch.defaultModel?.id,
          defaultThinkingLevel: patch.defaultThinkingLevel,
          enabledModels:
            patch.enabledModels?.length === 0 ? null : patch.enabledModels,
        }),
    );
  }
  saveConfig(
    cwd: string,
    expectedRevision: string,
    edit: ModelConfigEdit,
  ): Promise<void> {
    return editConfigurationDocument(
      {
        ...this.modelsFile,
        expectedRevision,
        validate: (path) =>
          validateModelConfig(cwd, this.agentDir, path).catch(() => {
            throw requestError(invalidDeclaration, 400);
          }),
      },
      modelsDocument,
      (current) => applyModelEdit(current, edit),
    );
  }
}

function editProvider(
  raw: unknown,
  edit: Exclude<ModelConfigEdit, { kind: "remove-provider" }>,
): JsonObject {
  if (!isJsonRecord(raw))
    throw requestError("Repair this provider declaration before saving", 409);
  if (edit.kind === "provider")
    return applyConfigurationPatch(raw, edit.values);
  const models = raw.models === undefined ? [] : raw.models;
  if (!Array.isArray(models))
    throw requestError("Repair this provider's models list before saving", 409);

  const removing = edit.kind === "remove-model";
  const original = removing ? edit.id : edit.originalId;
  const type =
    (removing ? edit.type : (edit.originalType ?? edit.values.type)) ?? "chat";
  const index = models.findIndex((model) =>
    isModelDeclaration(model, original, type),
  );
  if (original !== undefined && index < 0)
    throw requestError("That declaration no longer exists", 409);
  if (removing) {
    models.splice(index, 1);
  } else {
    const previous = models[index];
    const model = applyConfigurationPatch(
      isJsonRecord(previous) ? previous : {},
      edit.values,
    );
    if (
      models.some(
        (candidate, i) =>
          i !== index &&
          isModelDeclaration(candidate, edit.values.id, model.type ?? "chat"),
      )
    )
      throw requestError("A model with that ID already exists", 400);
    models[index < 0 ? models.length : index] = model;
  }
  return { ...raw, models };
}

function isModelDeclaration(
  model: unknown,
  id: string | undefined,
  type: unknown,
) {
  return (
    id !== undefined &&
    isJsonRecord(model) &&
    model.id === id &&
    (model.type ?? "chat") === type
  );
}
