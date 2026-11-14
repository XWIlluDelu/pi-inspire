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

  constructor(private readonly type: "prompt" | "pending") {}

  private find(
    id: string,
    fingerprint: string | undefined,
    observe: boolean,
  ): Promise<Result> | undefined {
    this.retire(Date.now());
    const receipt = this.receipts.get(id);
    if (!receipt) return;
    if (fingerprint !== undefined && receipt.fingerprint !== fingerprint)
      throw this.refusal(
        "MISMATCH",
        this.type === "prompt"
          ? "That prompt operation ID belongs to different content"
          : "That Pending operation belongs to another session view or action",
        observe && this.type === "prompt",
      );
    if (!receipt.result)
      throw this.refusal(
        "RESULT_RETIRED",
        this.type === "prompt"
          ? "This Host resolved that prompt operation, but its receipt retired; inspect the conversation before resending"
          : "This Pending recovery receipt retired before it could be reclaimed",
        true,
      );
    return receipt.result;
  }

  private refusal(suffix: string, message: string, outcomeUnknown: boolean) {
    return requestError(message, 409, {
      code: `${this.type.toUpperCase()}_OPERATION_${suffix}`,
      ...(outcomeUnknown ? { outcomeUnknown } : {}),
    });
  }

  observe(id: string, fingerprint?: string): Promise<Result> {
    const result = this.find(id, fingerprint, true);
    if (!result)
      throw this.refusal(
        "NOT_FOUND",
        `This Host cannot identify that ${this.type === "prompt" ? "prompt receipt" : "Pending operation"}`,
        true,
      );
    return result;
  }

  run(
    id: string,
    fingerprint: string,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    const existing = this.find(id, fingerprint, false);
    if (existing) return existing;
    if (this.receipts.size >= 65_536)
      throw requestError(
        `This Host has reached its ${this.type === "prompt" ? "process-lifetime prompt" : "Pending"} receipt limit`,
        503,
        {
          code: `${this.type.toUpperCase()}_OPERATION_CAPACITY`,
        },
      );
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
