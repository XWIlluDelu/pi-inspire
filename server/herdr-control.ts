import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { readLocalJsonLine, writeLocalJsonLine } from "./local-json-line.js";

export class HerdrApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrApiError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Herdr control response");
  return value as Record<string, unknown>;
}

async function socketIdentity(address: string, boot: string): Promise<string> {
  const info = await lstat(address, { bigint: true });
  if (!info.isSocket() || info.uid !== BigInt(process.getuid!()))
    throw new Error(
      "Herdr control endpoint is not a socket owned by this user",
    );
  return createHash("sha256")
    .update(`${boot}\0${address}\0${info.dev}\0${info.ino}\0${info.ctimeNs}`)
    .digest("hex");
}

/** Herdr serves one request per connection. Every request pins the same server
 * incarnation before and after connect, then writes to that connected FD. A
 * restarted daemon can break the FD, but cannot redirect it to a new pane.
 */
export class HerdrControl {
  private tail: Promise<unknown> = Promise.resolve();
  private socket: Socket | null = null;
  private closed = false;

  private constructor(
    private readonly address: string,
    private readonly boot: string,
    readonly identity: string,
  ) {}

  static async open(address: string, protocol: number): Promise<HerdrControl> {
    const boot = (
      await readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ).trim();
    const control = new HerdrControl(
      address,
      boot,
      await socketIdentity(address, boot),
    );
    try {
      const pong = await control.request("ping", {});
      if (pong.protocol !== protocol)
        throw new Error("Herdr protocol changed while connecting");
      return control;
    } catch (error) {
      control.close();
      throw error;
    }
  }

  get available(): boolean {
    return !this.closed;
  }

  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const request = this.tail.then(() => this.requestInside(method, params));
    this.tail = request.catch(() => undefined);
    return request;
  }

  private async assertCurrent(): Promise<void> {
    if (this.closed) throw new Error("Herdr control connection is closed");
    if (this.identity !== (await socketIdentity(this.address, this.boot)))
      throw new Error("Herdr control endpoint changed while connecting");
    if (this.closed) throw new Error("Herdr control connection is closed");
  }

  private async requestInside(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(8_000);
    let socket: Socket | null = null;
    try {
      await this.assertCurrent();
      socket = connect(this.address);
      this.socket = socket;
      socket.on("error", () => socket?.destroy());
      await once(socket, "connect", { signal });
      await this.assertCurrent();
      const id = randomUUID();
      writeLocalJsonLine(socket, { id, method, params });
      const response = record(await readLocalJsonLine(socket, signal));
      if (response.id !== id)
        throw new Error("Herdr response identity mismatch");
      if (response.error) {
        const error = record(response.error);
        if (typeof error.code !== "string" || typeof error.message !== "string")
          throw new Error("Invalid Herdr error response");
        throw new HerdrApiError(error.code, error.message);
      }
      return record(response.result);
    } catch (error) {
      if (!(error instanceof HerdrApiError)) this.close();
      throw error;
    } finally {
      socket?.destroy();
      this.socket = null;
    }
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
  }
}
