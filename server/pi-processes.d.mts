export interface PiProcessIdentity {
  pid: number;
  uid: number;
  /** Native process-birth identity; Linux /proc stat start ticks. */
  startTime: string;
  /** Exact native process title, not the full command line. */
  title: string;
  /** Linux state: zombie/dead (Z/X/x) counts as exited. */
  state: string;
  /** Native parent PID when available. */
  parentPid?: number;
  /** Inherited native Herdr pane + socket environment markers are present. */
  inHerdr: boolean;
}

export interface PiProcessAdapter {
  uid: number;
  /** Snapshot PIDs, including unrelated processes; selection happens centrally. */
  enumerate(): Promise<readonly number[]>;
  /** null means absent or foreign-owned; access failures must throw. */
  inspect(pid: number): Promise<PiProcessIdentity | null>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void | Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface StopAllPiProcessesOptions {
  platform?: NodeJS.Platform;
  /** Include Herdr-hosted Pi; false by default. */
  includeHerdr?: boolean;
  /** Supply the entire adapter for tests; never mix fake and native hooks. */
  adapter?: PiProcessAdapter;
  /** Defaults to 5000 ms. */
  graceMs?: number;
  /** Defaults to 1000 ms after SIGKILL. */
  killWaitMs?: number;
  /** Defaults to 50 ms. */
  pollMs?: number;
}

export interface PiRestartAncestorIdentity {
  pid: number;
  parentPid: number;
  uid: number;
  startTime: string;
  title: string;
  state: string;
}

export interface PiRestartAncestryAdapter {
  uid: number;
  /** Inspect foreign-owned ancestors too; null means absent. Access failures throw. */
  inspect(pid: number): Promise<PiRestartAncestorIdentity | null>;
}

export interface ExternalPiRestartCallerOptions {
  platform?: NodeJS.Platform;
  /** Starting PID; defaults to this process. */
  pid?: number;
  adapter?: PiRestartAncestryAdapter;
}

/** Linux only. Reject Pi-descended or unverifiable callers before service mutation. */
export function assertExternalPiRestartCaller(
  options?: ExternalPiRestartCallerOptions,
): Promise<void>;

/** Linux only; other platforms fail before discovery or signalling. */
export function supportsGlobalPiStop(platform?: NodeJS.Platform): boolean;
export function createLinuxPiProcessAdapter(): PiProcessAdapter;
/** Includes independently discovered nested Pi; never signals non-Pi descendants. */
export function stopAllPiProcesses(
  options?: StopAllPiProcessesOptions,
): Promise<void>;
