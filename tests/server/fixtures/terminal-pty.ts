import {
  type TerminalPty,
  type TerminalPtySpawnOptions,
  TerminalSessionManager,
} from "../../../server/terminal-session-manager.js";

export class FakePty implements TerminalPty {
  readonly process = "bash";
  readonly writes: Buffer[] = [];
  readonly resizes: Array<[number, number]> = [];
  readonly signals: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string | Buffer) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();
  private exited = false;

  constructor(readonly pid = 1234) {}

  onData(listener: (data: string | Buffer) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  write(data: string | Buffer): void {
    this.writes.push(Buffer.from(data));
  }

  kill(signal?: string): void {
    this.signals.push(signal);
    this.emitExit(0, signal === "SIGKILL" ? 9 : 1);
  }

  emitData(data: string | Buffer): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener({ exitCode, signal });
  }
}

export function terminalManagerWithFakePty(
  options: ConstructorParameters<typeof TerminalSessionManager>[0] = {},
) {
  const spawns: Array<{
    shell: string;
    args: string[];
    options: TerminalPtySpawnOptions;
    pty: FakePty;
  }> = [];
  const manager = new TerminalSessionManager({
    profiles: [
      {
        id: "bash",
        label: "Bash",
        shell: "/bin/bash",
        args: ["-l"],
        available: true,
        isDefault: true,
      },
    ],
    ...options,
    ptyFactory: (shell, args, spawnOptions) => {
      const pty = new FakePty();
      spawns.push({ shell, args, options: spawnOptions, pty });
      return pty;
    },
  });
  return { manager, spawns };
}
