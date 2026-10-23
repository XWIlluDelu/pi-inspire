import { existsSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { inspireConfigDirectory } from "./platform-paths.mjs";
import {
  emptyToolPresentationConfiguration,
  type PresentationAdapterInfo,
  type ToolPresentationConfiguration,
  toolPresentationConfigurationSchema,
} from "../shared/tool-presentation-config.js";

const MAX_CONFIG_BYTES = 256 * 1024;

export interface ToolPresentationConfigurationState {
  configuration: ToolPresentationConfiguration;
  adapters?: PresentationAdapterInfo[];
  warning?: string;
}

export interface ToolPresentationConfigLike {
  inspect(
    enabled?: Readonly<Record<string, boolean>>,
  ): Promise<ToolPresentationConfigurationState>;
}

/** Source checkouts use an ignored reference; installed packages use XDG config.
 * Both read the same data-only adapter format without changing the web build. */
export function defaultToolPresentationConfigPath(root: string): string {
  if (existsSync(join(root, ".git")))
    return join(root, ".inspire", "tool-presentations.json");
  return join(inspireConfigDirectory(), "tool-presentations.json");
}

async function readConfiguration(
  path: string,
): Promise<ToolPresentationConfiguration> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error("the configured path is not a file");
    if (metadata.size > MAX_CONFIG_BYTES)
      throw new Error("the file exceeds 262,144 bytes");
    const source = await handle.readFile("utf8");
    if (Buffer.byteLength(source) > MAX_CONFIG_BYTES)
      throw new Error("the file exceeds 262,144 bytes");
    let decoded: unknown;
    try {
      decoded = JSON.parse(source);
    } catch {
      throw new Error("the file is not valid JSON");
    }
    const parsed = toolPresentationConfigurationSchema.safeParse(decoded);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `${issue?.message ?? "the schema is invalid"}${issue?.path.length ? " at " + issue.path.join(".") : ""}`,
      );
    }
    return parsed.data;
  } finally {
    await handle.close();
  }
}

function compose(
  base: ToolPresentationConfiguration,
  module: ToolPresentationConfiguration,
): ToolPresentationConfiguration {
  // Explicit profile order is precedence. Lists with identities replace in place.
  const keyed = <T>(
    left: T[] = [],
    right: T[] = [],
    key: (value: T) => string,
  ) => [
    ...new Map(
      [...left, ...right].map((value) => [key(value), value]),
    ).values(),
  ];
  const merged = {
    ...base,
    rules: { ...base.rules, ...module.rules },
    mappings: { ...base.mappings, ...module.mappings },
    ...(module.thinking ? { thinking: module.thinking } : {}),
    ...(base.customMessages || module.customMessages
      ? {
          customMessages: { ...base.customMessages, ...module.customMessages },
        }
      : {}),
    ...(base.hiddenStatuses || module.hiddenStatuses
      ? {
          hiddenStatuses: [
            ...new Set([
              ...(base.hiddenStatuses ?? []),
              ...(module.hiddenStatuses ?? []),
            ]),
          ],
        }
      : {}),
    ...(base.controls || module.controls
      ? {
          controls: keyed(
            base.controls,
            module.controls,
            (control) => control.id,
          ),
        }
      : {}),
    ...(base.checkpoints || module.checkpoints
      ? {
          checkpoints: keyed(
            base.checkpoints,
            module.checkpoints,
            (checkpoint) => checkpoint.source,
          ),
        }
      : {}),
  };
  const validated = toolPresentationConfigurationSchema.parse(merged);
  if (Buffer.byteLength(JSON.stringify(validated)) > MAX_CONFIG_BYTES)
    throw new Error("the combined profile exceeds 262,144 bytes");
  return validated;
}

export class ToolPresentationConfigStore implements ToolPresentationConfigLike {
  constructor(readonly path: string) {}

  async inspect(
    enabled: Readonly<Record<string, boolean>> = {},
  ): Promise<ToolPresentationConfigurationState> {
    let profile: ToolPresentationConfiguration;
    let baseDirectory: string;
    try {
      profile = await readConfiguration(this.path);
      baseDirectory = dirname(await realpath(this.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { configuration: emptyToolPresentationConfiguration() };
      return {
        configuration: emptyToolPresentationConfiguration(),
        warning: `Custom tool presentations were not loaded: ${error instanceof Error ? error.message : "the configuration file could not be read"}. Built-in presentations remain active.`,
      };
    }
    const { adapters: references, ...base } = profile;
    let configuration = base;
    if (!references) return { configuration };
    const adapters: PresentationAdapterInfo[] = [];
    for (const reference of references) {
      const info: PresentationAdapterInfo = {
        id: reference.id,
        name: reference.name,
        enabled: enabled[reference.id] ?? reference.enabled ?? true,
      };
      adapters.push(info);
      if (!info.enabled) continue;
      try {
        const module = await readConfiguration(
          resolve(baseDirectory, reference.path),
        );
        if (module.adapters)
          throw new Error("adapter files cannot include other adapters");
        configuration = compose(configuration, module);
      } catch (error) {
        info.warning = `Could not load ${reference.name}: ${error instanceof Error ? error.message : "the adapter file could not be read"}`;
      }
    }
    const warnings = adapters.flatMap((adapter) =>
      adapter.warning ? [adapter.warning] : [],
    );
    return {
      configuration,
      adapters,
      ...(warnings.length ? { warning: warnings.join("\n") } : {}),
    };
  }
}
