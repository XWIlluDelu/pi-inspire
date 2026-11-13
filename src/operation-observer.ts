/** Transport observers can come and go while the original executor runs.
 * Dispatch once and keep the first confirmed result available to every caller. */
export class OperationObserver<Owner, Result> {
  private dispatched = false;
  private result?: { value: Result };
  private observation?: { owner: Owner; promise: Promise<Result> };
  private readonly confirmation: Promise<Result>;
  private confirm!: (result: Result) => void;
  private reject!: (error: unknown) => void;
  private terminal = false;
  private claimed = false;

  constructor() {
    this.confirmation = new Promise<Result>((resolve, reject) => {
      this.confirm = resolve;
      this.reject = reject;
    });
    // An observation can fail before anyone else is waiting on confirmation.
    void this.confirmation.catch(() => {});
  }

  async observe(
    owner: Owner,
    adapter: {
      start(): Promise<Result>;
      read(): Promise<Result>;
      rejected(error: unknown): boolean;
      recover(error: unknown): boolean;
    },
    readOnly: boolean,
  ): Promise<Result> {
    if (this.terminal) return this.confirmation;
    if (readOnly || this.observation?.owner !== owner) {
      const dispatch = !readOnly && !this.dispatched;
      if (dispatch) this.dispatched = true;
      const promise = Promise.resolve()
        .then(() => (dispatch ? adapter.start() : adapter.read()))
        .catch((error: unknown) => {
          if (dispatch && adapter.recover(error)) return adapter.read();
          throw error;
        })
        .then(
          (value) => {
            if (!this.terminal) {
              this.terminal = true;
              this.result = { value };
              this.confirm(value);
            }
            return this.confirmation;
          },
          (error: unknown) => {
            if (!this.terminal && adapter.rejected(error)) {
              this.terminal = true;
              this.reject(error);
            }
            if (this.terminal) return this.confirmation;
            throw error;
          },
        );
      this.observation = { owner, promise };
    }
    const observation = this.observation!;
    try {
      return await Promise.race([observation.promise, this.confirmation]);
    } finally {
      if (this.observation === observation) this.observation = undefined;
    }
  }

  claim(): { value: Result } | undefined {
    if (!this.result || this.claimed) return;
    this.claimed = true;
    return this.result;
  }
}
