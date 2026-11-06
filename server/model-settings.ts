import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRuntime as NativeModelRuntime } from "@earendil-works/pi-coding-agent";
import stripJsonComments from "strip-json-comments";
import { type ModelOption, THINKING_LEVELS } from "../shared/contracts.js";
import type {
  ModelConfigEdit,
  ModelPreferencesPatch,
  ModelSettingsSnapshot,
  PiModelPreferences,
  ProviderDeclaration,
} from "../shared/model-settings.js";
import {
  editConfigurationFile,
  readConfigurationText as textAt,
} from "./configuration-file.js";
import { modelSettings } from "./model-catalog.js";
import { validateModelConfig } from "./model-metadata.js";
import {
  getAgentDir,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
} from "./pi-runtime.js";
import { requestError } from "./request-error.js";

type JsonObject = Record<string, unknown>;
const revision = (text: string | undefined) =>
  createHash("sha256")
    .update(text === undefined ? "missing" : `file:${text}`)
    .digest("hex");
function object(text: string | undefined, comments = false): JsonObject {
  const source = text?.replace(/^\uFEFF/u, "");
  const value =
    source === undefined
      ? {}
      : JSON.parse(comments ? stripJsonComments(source) : source);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object");
  return value;
}
const string = (value: unknown) =>
  typeof value === "string" ? value : undefined;
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
const MODEL_FIELDS = [
  "id",
  "name",
  "api",
  "baseUrl",
  "reasoning",
  "input",
  "contextWindow",
  "maxTokens",
  "type",
];
function declarationProjection(config: JsonObject): ProviderDeclaration[] {
  const providers = config.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers))
    return [];
  return Object.entries(providers).flatMap(([id, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const provider = value as JsonObject;
    return [
      {
        id,
        baseUrl: string(provider.baseUrl),
        api: string(provider.api),
        apiKeyConfigured: provider.apiKey !== undefined,
        advancedFields: Object.keys(provider).filter(
          (key) => !["baseUrl", "api", "apiKey", "models"].includes(key),
        ),
        models: Array.isArray(provider.models)
          ? provider.models.flatMap((value) => {
              if (
                !value ||
                typeof value !== "object" ||
                Array.isArray(value) ||
                typeof value.id !== "string"
              )
                return [];
              const model = value as JsonObject;
              return [
                {
                  id: model.id as string,
                  name: string(model.name),
                  api: string(model.api),
                  baseUrl: string(model.baseUrl),
                  type: string(model.type),
                  reasoning:
                    typeof model.reasoning === "boolean"
                      ? model.reasoning
                      : undefined,
                  input: Array.isArray(model.input)
                    ? model.input.filter(
                        (item): item is string => typeof item === "string",
                      )
                    : undefined,
                  contextWindow:
                    typeof model.contextWindow === "number"
                      ? model.contextWindow
                      : undefined,
                  maxTokens:
                    typeof model.maxTokens === "number"
                      ? model.maxTokens
                      : undefined,
                  advancedFields: Object.keys(model).filter(
                    (key) => !MODEL_FIELDS.includes(key),
                  ),
                },
              ];
            })
          : [],
      },
    ];
  });
}

async function editFile(
  path: string,
  expectedRevision: string,
  transform: (current: JsonObject) => Promise<JsonObject>,
  comments = false,
): Promise<void> {
  await editConfigurationFile(
    { path, expectedRevision, revision },
    async (source) => {
      let parsed: JsonObject;
      try {
        parsed = object(source, comments);
      } catch {
        throw requestError(
          "Repair the invalid Pi JSON file before saving",
          409,
        );
      }
      return `${JSON.stringify(await transform(parsed), null, 2)}\n`;
    },
  );
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
    const settingsText = await textAt(join(this.agentDir, "settings.json"));
    const configText = await textAt(join(this.agentDir, "models.json"));
    let global: JsonObject = {},
      config: JsonObject = {};
    let settingsError: string | undefined, configError: string | undefined;
    try {
      global = object(settingsText);
    } catch {
      settingsError =
        "settings.json is invalid. Repair the file before saving.";
    }
    try {
      config = object(configText, true);
    } catch {
      configError = "models.json is invalid. Repair the file before saving.";
    }
    const settings = modelSettings(cwd, this.agentDir);
    const project = settings.getProjectSettings();
    const effective = preferences({
      defaultProvider: settings.getDefaultProvider(),
      defaultModel: settings.getDefaultModel(),
      defaultThinkingLevel: settings.getDefaultThinkingLevel(),
      enabledModels: settings.getEnabledModels(),
    });
    const settingsErrors = settings.drainErrors();
    if (settingsErrors.some((error) => error.scope === "global"))
      settingsError ??=
        "Global Pi settings could not be loaded. Repair settings.json before saving.";
    const projectSettingsError = settingsErrors.some(
      (error) => error.scope === "project",
    )
      ? "Project settings could not be loaded. Showing global defaults; global settings remain editable. Repair this project's .pi/settings.json to restore its overrides."
      : undefined;
    const saved = preferences(
      settingsError ? global : (settings.getGlobalSettings() as JsonObject),
    );
    return {
      settingsRevision: revision(settingsText),
      configRevision: revision(configText),
      saved,
      effective,
      projectOverrides: [
        "defaultProvider",
        "defaultModel",
        "defaultThinkingLevel",
        "enabledModels",
      ].filter((key) => Object.hasOwn(project, key)),
      providers: declarationProjection(config),
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
      ...(configError ? { configError } : {}),
    };
  }
  async savePreferences(
    expected: string,
    patch: ModelPreferencesPatch,
  ): Promise<void> {
    await editFile(
      join(this.agentDir, "settings.json"),
      expected,
      async (current) => {
        let serialized = JSON.stringify(current);
        const settings = SettingsManager.fromStorage({
          withLock: (scope, fn) => {
            const next = fn(scope === "global" ? serialized : undefined);
            if (scope === "global" && next !== undefined) serialized = next;
          },
        });
        if (patch.defaultModel)
          settings.setDefaultModelAndProvider(
            patch.defaultModel.provider,
            patch.defaultModel.id,
          );
        if (patch.defaultThinkingLevel)
          settings.setDefaultThinkingLevel(patch.defaultThinkingLevel);
        if (patch.enabledModels !== undefined)
          settings.setEnabledModels(
            patch.enabledModels.length ? patch.enabledModels : undefined,
          );
        await settings.flush();
        if (settings.drainErrors().length)
          throw requestError("Pi could not save model settings", 409);
        const next = object(serialized);
        if (patch.defaultModel === null) {
          delete next.defaultProvider;
          delete next.defaultModel;
        }
        if (patch.defaultThinkingLevel === null)
          delete next.defaultThinkingLevel;
        return next;
      },
    );
  }
  async saveConfig(
    cwd: string,
    expected: string,
    edit: ModelConfigEdit,
  ): Promise<void> {
    await editFile(
      join(this.agentDir, "models.json"),
      expected,
      async (current) => {
        if (
          current.providers !== undefined &&
          (!current.providers ||
            typeof current.providers !== "object" ||
            Array.isArray(current.providers))
        )
          throw requestError("models.json providers must be an object", 409);
        const providers = (current.providers ??= {}) as JsonObject;
        const providerId = "provider" in edit ? edit.provider : edit.id;
        if (edit.kind === "remove-provider") delete providers[providerId];
        else {
          const value = Object.hasOwn(providers, providerId)
            ? providers[providerId]
            : {};
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw requestError(
              "Repair this provider declaration before saving",
              409,
            );
          const provider = value as JsonObject;
          if (edit.kind === "provider") {
            for (const [key, value] of Object.entries(edit.values)) {
              if (value === null) delete provider[key];
              else provider[key] = value;
            }
          } else {
            if (
              provider.models !== undefined &&
              !Array.isArray(provider.models)
            )
              throw requestError(
                "Repair this provider's models list before saving",
                409,
              );
            const models = (provider.models ??= []) as JsonObject[];
            const id = edit.kind === "model" ? edit.originalId : edit.id;
            const type =
              edit.kind === "model"
                ? (edit.originalType ?? edit.values.type ?? "chat")
                : (edit.type ?? "chat");
            const index = models.findIndex(
              (model) => model.id === id && (model.type ?? "chat") === type,
            );
            if (edit.kind === "remove-model") {
              if (index < 0)
                throw requestError("That declaration no longer exists", 409);
              models.splice(index, 1);
            } else {
              if (
                models.some(
                  (model, i) =>
                    i !== index &&
                    model.id === edit.values.id &&
                    (model.type ?? "chat") === (edit.values.type ?? type),
                )
              )
                throw requestError("A model with that ID already exists", 400);
              const model = index >= 0 ? { ...models[index] } : {};
              for (const key of MODEL_FIELDS) {
                if (Object.hasOwn(edit.values, key)) {
                  const value = (edit.values as unknown as JsonObject)[key];
                  if (value === null) delete model[key];
                  else model[key] = value;
                }
              }
              if (index < 0) models.push(model);
              else models[index] = model;
            }
          }
          Object.defineProperty(providers, providerId, {
            value: provider,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        // Bind the same trusted provider registrations as Pi before validating.
        // The disposable metadata worker never starts a turn or persistent session.
        const validationPath = join(
          this.agentDir,
          `.inspire-validate-${randomUUID()}.json`,
        );
        try {
          await writeFile(validationPath, JSON.stringify(current), {
            mode: 0o600,
          });
          try {
            await validateModelConfig(cwd, this.agentDir, validationPath);
          } catch {
            throw requestError(
              "Pi rejected this declaration. Check its endpoint, API, model fields and extensions.",
              400,
            );
          }
        } finally {
          await rm(validationPath, { force: true });
        }
        return current;
      },
      true,
    );
  }
}
