import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  emptyToolPresentationConfiguration,
  type ToolPresentationConfiguration,
  toolPresentationConfigurationSchema,
} from "../shared/tool-presentation-config.js";

const MAX_CONFIG_BYTES = 256 * 1024;

export interface ToolPresentationConfigurationState {
  configuration: ToolPresentationConfiguration;
  warning?: string;
}

export interface ToolPresentationConfigLike {
  inspect(): Promise<ToolPresentationConfigurationState>;
}

/** Source checkouts keep machine-local presentation declarations under their
 * already ignored .inspire directory. Installed packages use the ordinary XDG
 * user configuration directory instead of writing into package contents. */
export function defaultToolPresentationConfigPath(root: string): string {
  if (existsSync(join(root, ".git")))
    return join(root, ".inspire", "tool-presentations.json");
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "inspire", "tool-presentations.json");
}

function warning(reason: string): ToolPresentationConfigurationState {
  return {
    configuration: emptyToolPresentationConfiguration(),
    warning: `Custom tool presentations were not loaded: ${reason}. Built-in presentations remain active.`,
  };
}

export class ToolPresentationConfigStore implements ToolPresentationConfigLike {
  constructor(readonly path: string) {}

  async inspect(): Promise<ToolPresentationConfigurationState> {
    let handle;
    try {
      handle = await open(this.path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { configuration: emptyToolPresentationConfiguration() };
      return warning("the configuration file could not be opened");
    }

    try {
      const metadata = await handle.stat();
      if (!metadata.isFile())
        return warning("the configured path is not a file");
      if (metadata.size > MAX_CONFIG_BYTES)
        return warning(
          `the file exceeds ${MAX_CONFIG_BYTES.toLocaleString()} bytes`,
        );
      const source = await handle.readFile("utf8");
      if (Buffer.byteLength(source) > MAX_CONFIG_BYTES)
        return warning(
          `the file exceeds ${MAX_CONFIG_BYTES.toLocaleString()} bytes`,
        );
      let decoded: unknown;
      try {
        decoded = JSON.parse(source);
      } catch {
        return warning("the file is not valid JSON");
      }
      const parsed = toolPresentationConfigurationSchema.safeParse(decoded);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const location = issue?.path.length
          ? ` at ${issue.path.join(".")}`
          : "";
        return warning(
          `${issue?.message ?? "the schema is invalid"}${location}`,
        );
      }
      return { configuration: parsed.data };
    } catch {
      return warning("the configuration file could not be read");
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
