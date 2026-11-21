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
