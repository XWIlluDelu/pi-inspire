import type {
  TerminalCatalogResponse,
  TerminalClientControlMessage,
  TerminalCreateRequest,
  TerminalDescriptor,
  TerminalMutationMethod,
  TerminalOperationIdentity,
  TerminalRemoveResponse,
  TerminalRenameRequest,
  TerminalServerControlMessage,
  TerminalServiceSettings,
  TerminalServiceSettingsPatch,
} from "../shared/terminal-contracts.js";

export interface TerminalAttachmentSink {
  sendControl(message: TerminalServerControlMessage): void;
  sendData(frame: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface TerminalAttachOptions {
  terminalId: string;
  clientId: string;
  cols: number;
  rows: number;
  outputEpoch?: string;
  nextOutputOffset?: number;
  resizeRevision?: number;
  ownerToken?: string;
}

export interface TerminalAttachment {
  readonly id: string;
  readonly terminalId: string;
  writeInput(sequence: number, data: Uint8Array): void;
  control(
    message: Exclude<TerminalClientControlMessage, { type: "attach" }>,
  ): void;
  detach(): void;
}

export interface TerminalService {
  operationEpoch(): Promise<string>;
  operate<Result>(
    method: TerminalMutationMethod,
    params: unknown,
    operation: TerminalOperationIdentity,
  ): Promise<Result>;
  list(
    cwd?: string,
  ): TerminalCatalogResponse | Promise<TerminalCatalogResponse>;
  create(request: TerminalCreateRequest): Promise<TerminalDescriptor>;
  rename(
    id: string,
    request: TerminalRenameRequest,
  ): Promise<TerminalDescriptor>;
  reorder(cwd: string, terminalIds: string[]): Promise<TerminalCatalogResponse>;
  restart(id: string): Promise<TerminalDescriptor>;
  remove(id: string, force: boolean): Promise<TerminalRemoveResponse>;
  getSettings(): TerminalServiceSettings | Promise<TerminalServiceSettings>;
  updateSettings(
    patch: TerminalServiceSettingsPatch,
  ): Promise<TerminalServiceSettings>;
  clearHistory(): Promise<void>;
  attach(
    options: TerminalAttachOptions,
    sink: TerminalAttachmentSink,
  ): Promise<TerminalAttachment>;
  close(): Promise<void>;
}

/** Initialize only on demand. Connection failures may be retried; dispatched work never is. */
export class LazyTerminalService implements TerminalService {
  private pending: Promise<TerminalService> | null = null;
  private service: TerminalService | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly connect: () => Promise<TerminalService>) {}

  operationEpoch(): Promise<string> {
    return this.run((service) => service.operationEpoch());
  }

  operate<Result>(
    method: TerminalMutationMethod,
    params: unknown,
    operation: TerminalOperationIdentity,
  ): Promise<Result> {
    return this.run((service) =>
      service.operate<Result>(method, params, operation),
    );
  }

  list(cwd?: string): Promise<TerminalCatalogResponse> {
    return this.run((service) => service.list(cwd));
  }

  create(request: TerminalCreateRequest): Promise<TerminalDescriptor> {
    return this.run((service) => service.create(request));
  }

  rename(
    id: string,
    request: TerminalRenameRequest,
  ): Promise<TerminalDescriptor> {
    return this.run((service) => service.rename(id, request));
  }

  reorder(
    cwd: string,
    terminalIds: string[],
  ): Promise<TerminalCatalogResponse> {
    return this.run((service) => service.reorder(cwd, terminalIds));
  }

  restart(id: string): Promise<TerminalDescriptor> {
    return this.run((service) => service.restart(id));
  }

  remove(id: string, force: boolean): Promise<TerminalRemoveResponse> {
    return this.run((service) => service.remove(id, force));
  }

  getSettings(): Promise<TerminalServiceSettings> {
    return this.run((service) => service.getSettings());
  }

  updateSettings(
    patch: TerminalServiceSettingsPatch,
  ): Promise<TerminalServiceSettings> {
    return this.run((service) => service.updateSettings(patch));
  }

  clearHistory(): Promise<void> {
    return this.run((service) => service.clearHistory());
  }

  attach(
    options: TerminalAttachOptions,
    sink: TerminalAttachmentSink,
  ): Promise<TerminalAttachment> {
    return this.run((service) => service.attach(options, sink));
  }

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

  private async connected(): Promise<TerminalService> {
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

  private async run<Result>(
    action: (service: TerminalService) => Result | Promise<Result>,
  ): Promise<Result> {
    const service = await this.connected();
    if (this.closed) throw this.closedError();
    return action(service);
  }
}

export class UnavailableTerminalService extends LazyTerminalService {
  constructor(reason: string) {
    super(() =>
      Promise.reject(
        new TerminalServiceError("terminal_service_unavailable", 503, reason),
      ),
    );
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
