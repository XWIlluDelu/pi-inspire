export function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform?: NodeJS.Platform,
): string | undefined;
export function windowsPowerShellCommand(environment?: NodeJS.ProcessEnv): string;
export function executablePathDirectories(
  value: string,
  platform?: NodeJS.Platform,
): string[];
