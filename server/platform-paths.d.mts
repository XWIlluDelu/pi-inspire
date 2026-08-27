interface PlatformPathOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  temporary?: string;
}

export function inspireConfigDirectory(options?: PlatformPathOptions): string;
export function inspireCacheDirectory(options?: PlatformPathOptions): string;
export function inspireStateDirectory(options?: PlatformPathOptions): string;
export function inspireRuntimeDirectory(options?: PlatformPathOptions): string;
export function supportsPosixPermissions(platform?: NodeJS.Platform): boolean;
