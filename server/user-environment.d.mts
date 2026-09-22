export function resolveLaunchEnvironment(
  environment?: NodeJS.ProcessEnv,
  options?: {
    service?: boolean;
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    maxBytes?: number;
  },
): Promise<NodeJS.ProcessEnv>;

export function systemdEnvironmentArguments(environment: NodeJS.ProcessEnv): string[];
