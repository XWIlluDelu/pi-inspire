export function preparePackagedLauncher(
  root: string,
  options?: { host?: string; terminal?: string },
): Promise<void>;
export function freeLoopbackPort(): Promise<number>;
export function directLauncherEnvironment(root: string): Promise<NodeJS.ProcessEnv>;
export function installSystemdManager(root: string): Promise<string>;
