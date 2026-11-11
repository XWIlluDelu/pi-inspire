import type { SpawnOptions } from "node:child_process";

export interface ProcessTreeChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ProcessTreeSignalOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  isolated?: boolean;
}

export function runChild(
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
): Promise<{ code: number; issued?: false; stdout: string; stderr: string }>;

export function isolatedProcessOptions(
  platform?: NodeJS.Platform,
): Pick<SpawnOptions, "detached" | "windowsHide">;

export function signalProcessTree(
  child: ProcessTreeChild,
  signal: NodeJS.Signals,
  options?: ProcessTreeSignalOptions,
): Promise<void>;
