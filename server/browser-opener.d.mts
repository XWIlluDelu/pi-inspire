import type { SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";

export function openBrowser(
  url: string,
  platform?: NodeJS.Platform,
  spawnDetached?: (command: string, args: string[], options: SpawnOptions) => EventEmitter & { unref(): void },
  environment?: NodeJS.ProcessEnv,
): Promise<void>;
