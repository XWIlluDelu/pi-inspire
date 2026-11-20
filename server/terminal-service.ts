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
  private connection: Promise<TerminalService> | null;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly connect: () => Promise<TerminalService>,
    service: TerminalService | null = null,
  ) {
    this.connection = service ? Promise.resolve(service) : null;
  }

  close(): Promise<void> {
    return (this.closing ??=
      this.connection?.then(
        (service) => service.close(),
        () => {},
      ) ?? Promise.resolve());
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
    if (this.closing) throw this.closedError();
    this.connection ??= Promise.resolve()
      .then(() => {
        if (this.closing) throw this.closedError();
        return this.connect();
      })
      .catch((error) => {
        this.connection = null;
        throw error;
      });
    const service = await this.connection;
    if (this.closing) throw this.closedError();
    return operation(service);
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
