declare module "proper-lockfile" {
  interface LockOptions {
    realpath?: boolean;
    retries?: {
      retries: number;
      factor: number;
      minTimeout: number;
      maxTimeout: number;
    };
    onCompromised?: (error: Error) => void;
  }
  const lockfile: {
    lock(path: string, options?: LockOptions): Promise<() => Promise<void>>;
  };
  export default lockfile;
}
