import type {
  TerminalCatalogResponse,
  TerminalServerControlMessage,
  TerminalServiceSettings,
} from "../shared/terminal-contracts.js";
import type {
  TerminalAttachOptions,
  TerminalIntent,
  TerminalOperation,
  TerminalOperationResults,
} from "../shared/terminal-operations.js";

export interface TerminalAttachmentSink {
  sendControl(message: TerminalServerControlMessage): void;
  sendData(frame: Uint8Array): void;
  close(code: number, reason: string): void;
}

export type TerminalClientFrame = { data: Uint8Array } | { control: unknown };

export interface TerminalAttachment {
  send(frame: TerminalClientFrame): void;
  detach(): void;
}

export interface TerminalService {
  operationEpoch(): Promise<string>;
  operate<I extends TerminalIntent>(
    operation: TerminalOperation & { intent: I },
    observeOnly?: boolean,
  ): Promise<TerminalOperationResults[I["command"]]>;
  list(
    cwd?: string,
  ): TerminalCatalogResponse | Promise<TerminalCatalogResponse>;
  getSettings(): TerminalServiceSettings | Promise<TerminalServiceSettings>;
  attach(
    options: TerminalAttachOptions,
    sink: TerminalAttachmentSink,
  ): Promise<TerminalAttachment>;
  close(): Promise<void>;
}

/** Initialize only on demand. Connection failures may be retried; dispatched work never is. */
export class TerminalConnection {
  private pending: Promise<TerminalService> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly connect: () => Promise<TerminalService>,
    private service: TerminalService | null = null,
  ) {}

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.pending?.catch(() => {});
      const service = this.service;
      this.service = null;
      await service?.close();
    })();
    return this.closing;
  }

  private closedError(): TerminalServiceError {
    return new TerminalServiceError(
      "terminal_service_closed",
      503,
      "The terminal service is stopping.",
    );
  }

  async run<Result>(
    operation: (service: TerminalService) => Result | Promise<Result>,
  ): Promise<Result> {
    const service = await this.connectOnce();
    if (this.closed) throw this.closedError();
    return operation(service);
  }

  private async connectOnce(): Promise<TerminalService> {
    if (this.closed) throw this.closedError();
    if (this.service) return this.service;
    if (this.pending) return this.pending;
    const pending: Promise<TerminalService> = Promise.resolve()
      .then(() => {
        if (this.closed) throw this.closedError();
        return this.connect();
      })
      .then(async (service) => {
        if (this.closed) {
          await service.close();
          throw this.closedError();
        }
        this.service = service;
        return service;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }
}

export class TerminalServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TerminalServiceError";
  }
}
