export interface FileLockOptions {
  waitMs?: number;
  retryMs?: number;
  invalidStaleMs?: number;
  initializationGraceMs?: number;
  label?: string;
}

export interface FileLockLease {
  path: string;
  owner: {
    schemaVersion: 1;
    pid: number;
    token: string;
    processStartTime: string;
    createdAt: string;
  };
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export function acquireFileLock(
  path: string,
  options?: FileLockOptions,
): Promise<FileLockLease>;
