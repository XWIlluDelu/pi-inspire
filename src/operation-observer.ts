import type {
  HostOperationCommand,
  HostOperationIdentity,
} from "../shared/host-operations";
import { ApiError } from "./http-request";

export function inputRejection(
  error: unknown,
  intent?: HostOperationIdentity & { action: HostOperationCommand },
): ApiError | null {
  if (!(error instanceof ApiError) || error.outcomeUnknown) return null;
  if (
    intent &&
    (error.authorityId !== intent.authorityId ||
      error.operation?.operationId !== intent.operationId ||
      error.operation?.command !== intent.action)
  ) return null;
  return error;
}

export function deferredReceipt<Result>() {
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

/** One in-flight observation of a receipt or lifecycle record. */
export class ReceiptRead<Owner, Result> {
  private active?: {
    owner: Owner;
    controller: AbortController;
    task: Promise<Result>;
  };

  get pending(): boolean {
    return this.active !== undefined;
  }

  get task(): Promise<Result> | undefined {
    return this.active?.task;
  }

  cancel(): void {
    const retired = this.active;
    this.active = undefined;
    retired?.controller.abort();
  }

  observe(
    owner: Owner,
    read: (signal: AbortSignal) => Promise<Result>,
    settled?: () => void,
  ): Promise<Result> {
    const previous = this.active;
    if (previous && previous.owner === owner) return previous.task;
    this.cancel();
    const controller = new AbortController();
    const { promise, resolve, reject } = deferredReceipt<Result>();
    const active = {
      owner,
      controller,
      task: promise.finally(() => {
        if (this.active !== active) return;
        this.active = undefined;
        settled?.();
      }),
    };
    this.active = active;
    try {
      read(controller.signal).then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return active.task;
  }
}

