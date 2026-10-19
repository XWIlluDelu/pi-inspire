import type { EventEmitter } from "node:events";

export const HOST_RESTART_EXIT_CODE: 75;

export interface LauncherRestartChannel extends EventEmitter {
  connected?: boolean;
  send?: (
    message: unknown,
    callback: (error: Error | null) => void,
  ) => boolean;
}

export function createLauncherRestartSupervisor(
  child: LauncherRestartChannel,
  options: {
    enabled: boolean;
    isStopping: () => boolean;
    assertOwned: () => Promise<void>;
  },
): {
  shouldRestart(code: number | null, signal: NodeJS.Signals | null): boolean;
  close(): void;
};

export function createLauncherRestartClient(
  channel?: LauncherRestartChannel,
  timeoutMs?: number,
): {
  inspect(): Promise<boolean>;
  request(commit: () => boolean): Promise<{ code: number; issued: boolean }>;
};
