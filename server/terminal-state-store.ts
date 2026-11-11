import { dirname } from "node:path";
import { ensurePrivateDirectory } from "./private-directory.js";
import { replacePrivateStateFile } from "./private-state-file.js";
import { readPrivateTerminalFile } from "./terminal-private-file.js";
import type { TerminalPersistedState } from "./terminal-session-manager.js";

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const WRITE_DELAY_MS = 200;

export function prepareTerminalStateDirectory(path: string): Promise<void> {
  return ensurePrivateDirectory(dirname(path), "terminal state directory");
}

export async function readTerminalState(path: string): Promise<unknown | null> {
  const data = await readPrivateTerminalFile(path, "state", MAX_STATE_BYTES);
  return data === null ? null : (JSON.parse(data.toString("utf8")) as unknown);
}

async function writeTerminalState(
  path: string,
  state: TerminalPersistedState,
): Promise<void> {
  await prepareTerminalStateDirectory(path);
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES)
    throw new Error("Terminal state exceeds its size limit");
  await replacePrivateStateFile(path, serialized, { flush: true });
}

export class TerminalStateWriter {
  private timer: NodeJS.Timeout | null = null;
  private tail = Promise.resolve();
  private dirty = false;

  constructor(
    private readonly path: string,
    private readonly snapshot: () => TerminalPersistedState,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueue();
    }, WRITE_DELAY_MS);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.enqueue();
    await this.tail;
  }

  private enqueue(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const state = this.snapshot();
    this.tail = this.tail
      .then(() => writeTerminalState(this.path, state))
      .catch((error) => this.onError(error));
  }
}
