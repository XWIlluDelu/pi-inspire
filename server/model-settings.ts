import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ModelRuntime as NativeModelRuntime } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
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
  getAgentDir,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
} from "./pi-runtime.js";
import { modelSettings } from "./model-catalog.js";
import { requestError } from "./request-error.js";

type JsonObject = Record<string, unknown>;
const revision = (text: string | undefined) =>
  createHash("sha256")
    .update(text === undefined ? "missing" : `file:${text}`)
    .digest("hex");
async function textAt(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw requestError("Pi configuration could not be read", 409);
  }
}
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

async function fileTarget(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let link: string;
  try {
    link = await readlink(path);
  } catch (error) {
    if (
      !["ENOENT", "EINVAL"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
    return join(await realpath(dirname(path)), basename(path));
  }
  return fileTarget(resolve(dirname(path), link));
}

/** Lock Pi's lexical path and the actual authority when config is symlinked.
 * Replace the target atomically, never the user's configuration symlink. */
async function editFile(
  path: string,
  expected: string,
  transform: (current: JsonObject) => Promise<JsonObject>,
  comments = false,
): Promise<void> {
  const target = await fileTarget(path);
  const lexical = join(await realpath(dirname(path)), basename(path));
  const releases: Array<() => Promise<void>> = [];
  let compromised = false;
  const temporary = join(
    dirname(target),
    `.inspire-models-${randomUUID()}.json`,
  );
  try {
    for (const authority of [...new Set([lexical, target])].sort()) {
      try {
        releases.push(
          await lockfile.lock(authority, {
            realpath: false,
            retries: { retries: 40, factor: 1, minTimeout: 50, maxTimeout: 50 },
            onCompromised: () => {
              compromised = true;
            },
          }),
        );
      } catch {
        throw requestError(
          "Pi configuration is being edited elsewhere. Reload and try again.",
          409,
        );
      }
    }
    const current = await textAt(path);
    if (revision(current) !== expected)
      throw requestError(
        "Pi configuration changed elsewhere. Reload before saving.",
        409,
      );
    let parsed: JsonObject;
    try {
      parsed = object(current, comments);
    } catch {
      throw requestError("Repair the invalid Pi JSON file before saving", 409);
    }
    const next = await transform(parsed);
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    if (
      compromised ||
      (await fileTarget(path)) !== target ||
      revision(await textAt(path)) !== expected
    )
      throw requestError(
        "Pi configuration changed elsewhere. Reload before saving.",
        409,
      );
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
    await Promise.all(
      releases.reverse().map(async (release) => {
        try {
          await release();
        } catch (error) {
          if (!compromised) throw error;
        }
      }),
    );
  }
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
    if (settings.drainErrors().length)
      settingsError ??=
        "Pi settings could not be loaded. Repair the file before saving.";
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
  async saveConfig(expected: string, edit: ModelConfigEdit): Promise<void> {
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
        // Validate with the installed Pi's native loader without resolving secrets,
        // loading extensions, networking, or writing the real config.
        const validationPath = join(
          this.agentDir,
          `.inspire-validate-${randomUUID()}.json`,
        );
        try {
          await writeFile(validationPath, JSON.stringify(current), {
            mode: 0o600,
          });
          const runtime = await ModelRuntime.create({
            modelsPath: validationPath,
            authPath: join(this.agentDir, "auth.json"),
            refreshOnCreate: false,
          });
          if (runtime.getError())
            throw requestError(
              "Pi rejected this declaration. Check its endpoint, API and model fields.",
              400,
            );
        } finally {
          await rm(validationPath, { force: true });
        }
        return current;
      },
      true,
    );
  }
}
