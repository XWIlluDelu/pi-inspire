import type {
  TerminalCatalogResponse,
  TerminalClientControlMessage,
  TerminalCreateRequest,
  TerminalDescriptor,
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

export class UnavailableTerminalService implements TerminalService {
  constructor(private readonly reason: string) {}

  list(): Promise<TerminalCatalogResponse> {
    return this.unavailable();
  }

  create(): Promise<TerminalDescriptor> {
    return this.unavailable();
  }

  rename(): Promise<TerminalDescriptor> {
    return this.unavailable();
  }

  reorder(): Promise<TerminalCatalogResponse> {
    return this.unavailable();
  }

  restart(): Promise<TerminalDescriptor> {
    return this.unavailable();
  }

  remove(): Promise<TerminalRemoveResponse> {
    return this.unavailable();
  }

  getSettings(): Promise<TerminalServiceSettings> {
    return this.unavailable();
  }

  updateSettings(): Promise<TerminalServiceSettings> {
    return this.unavailable();
  }

  clearHistory(): Promise<void> {
    return this.unavailable();
  }

  attach(): Promise<TerminalAttachment> {
    return this.unavailable();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private unavailable<Result>(): Promise<Result> {
    return Promise.reject(
      new TerminalServiceError(
        "terminal_service_unavailable",
        503,
        this.reason,
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
