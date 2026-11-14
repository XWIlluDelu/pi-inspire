import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
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
  if (!isJsonRecord(config.providers)) return [];
  return Object.entries(config.providers).flatMap(([id, provider]) => {
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
  constructor(private readonly agentDir = getAgentDir()) {}

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
      readConfigurationDocument(
        { path: join(this.agentDir, "settings.json") },
        settingsDocument,
      ),
      readConfigurationDocument(
        { path: join(this.agentDir, "models.json") },
        modelsDocument,
      ),
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
    expected: string,
    patch: ModelPreferencesPatch,
  ): Promise<void> {
    return editConfigurationDocument(
      {
        path: join(this.agentDir, "settings.json"),
        expectedRevision: expected,
      },
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
  async saveConfig(
    cwd: string,
    expected: string,
    edit: ModelConfigEdit,
  ): Promise<void> {
    await editConfigurationDocument(
      { path: join(this.agentDir, "models.json"), expectedRevision: expected },
      modelsDocument,
      async (current) => {
        if (current.providers !== undefined && !isJsonRecord(current.providers))
          throw requestError("models.json providers must be an object", 409);
        const providers = (current.providers ??= {}) as JsonObject;
        const providerId = "provider" in edit ? edit.provider : edit.id;
        if (edit.kind === "remove-provider") delete providers[providerId];
        else {
          const provider = Object.hasOwn(providers, providerId)
            ? providers[providerId]
            : {};
          if (!isJsonRecord(provider))
            throw requestError(
              "Repair this provider declaration before saving",
              409,
            );
          if (edit.kind === "provider") {
            current.providers = {
              ...providers,
              [providerId]: applyConfigurationPatch(provider, edit.values),
            };
          } else {
            if (
              provider.models !== undefined &&
              !Array.isArray(provider.models)
            )
              throw requestError(
                "Repair this provider's models list before saving",
                409,
              );
            const models = (provider.models ??= []) as unknown[];
            const id = edit.kind === "model" ? edit.originalId : edit.id;
            const originalType =
              edit.kind === "model"
                ? (edit.originalType ?? edit.values.type ?? "chat")
                : (edit.type ?? "chat");
            const index =
              id === undefined
                ? -1
                : models.findIndex((model) =>
                    isModelDeclaration(model, id, originalType),
                  );
            if (edit.kind === "remove-model") {
              if (index < 0)
                throw requestError("That declaration no longer exists", 409);
              models.splice(index, 1);
            } else {
              if (id !== undefined && index < 0)
                throw requestError("That declaration no longer exists", 409);
              const prior = models[index];
              const model = applyConfigurationPatch(
                isJsonRecord(prior) ? prior : {},
                edit.values,
              );
              if (
                models.some(
                  (candidate, i) =>
                    i !== index &&
                    isModelDeclaration(
                      candidate,
                      edit.values.id,
                      model.type ?? "chat",
                    ),
                )
              )
                throw requestError("A model with that ID already exists", 400);
              models[index < 0 ? models.length : index] = model;
            }
            current.providers = { ...providers, [providerId]: provider };
          }
        }
        // Bind the same trusted provider registrations as Pi before validating.
        // The disposable metadata worker never starts a turn or persistent session.
        const validationPath = join(
          this.agentDir,
          `.inspire-validate-${randomUUID()}.json`,
        );
        await writeFile(validationPath, JSON.stringify(current), {
          mode: 0o600,
          flag: "wx",
        });
        try {
          await validateModelConfig(cwd, this.agentDir, validationPath);
        } catch {
          throw requestError(
            "Pi rejected this declaration. Check its endpoint, API, model fields and extensions.",
            400,
          );
        } finally {
          await rm(validationPath, { force: true }).catch(() => undefined);
        }
        return current;
      },
    );
  }
}

function isModelDeclaration(model: unknown, id: string, type: unknown) {
  return (
    isJsonRecord(model) && model.id === id && (model.type ?? "chat") === type
  );
}
