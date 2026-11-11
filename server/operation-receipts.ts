import { requestError } from "./request-error.js";

interface Receipt<Result> {
  fingerprint: string;
  result: Promise<Result> | null;
}

/** Retire large results while keeping their identities for this Host's lifetime. */
export class OperationReceipts<Result> {
  private readonly receipts = new Map<string, Receipt<Result>>();
  private readonly settled: Array<{
    receipt: Receipt<Result>;
    bytes: number;
    at: number;
  }> = [];
  private bytes = 0;

  constructor(
    private readonly capacityError: { message: string; code: string },
  ) {}

  get(id: string): Receipt<Result> | undefined {
    this.retire(Date.now());
    return this.receipts.get(id);
  }

  start(
    id: string,
    fingerprint: string,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    if (this.receipts.size >= 65_536)
      throw requestError(this.capacityError.message, 503, {
        code: this.capacityError.code,
      });
    const result = Promise.resolve().then(execute);
    const receipt: Receipt<Result> = { fingerprint, result };
    this.receipts.set(id, receipt);
    const settle = (bytes: number) => {
      const at = Date.now();
      this.bytes += bytes;
      this.settled.push({ receipt, bytes, at });
      this.retire(at);
    };
    void result.then(
      (value) => settle(Buffer.byteLength(JSON.stringify(value))),
      () => settle(0),
    );
    return result;
  }

  private retire(now: number): void {
    while (this.settled.length) {
      const first = this.settled[0]!;
      if (
        this.settled.length <= 2_048 &&
        this.bytes <= 32 * 1024 * 1024 &&
        now - first.at <= 15 * 60_000
      )
        break;
      this.settled.shift();
      this.bytes -= first.bytes;
      first.receipt.result = null;
    }
  }
}
