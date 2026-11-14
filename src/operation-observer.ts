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
  ): Promise<Result> {
    const previous = this.active;
    if (previous && previous.owner === owner) return previous.task;
    this.cancel();
    const controller = new AbortController();
    let resolve!: (result: Result) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<Result>((accept, refuse) => {
      resolve = accept;
      reject = refuse;
    });
    const active = {
      owner,
      controller,
      task: result.finally(() => {
        if (this.active === active) this.active = undefined;
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

/** Transport observers can come and go while the original executor runs.
 * Dispatch once and keep the first confirmed result available to every caller. */
export class OperationObserver<Owner, Result> {
  private dispatched = false;
  private result?: { value: Result };
  private readonly observation = new ReceiptRead<Owner, Result>();
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
    if (readOnly) this.observation.cancel();
    const task = this.observation.observe(owner, async () => {
      const dispatch = !readOnly && !this.dispatched;
      if (dispatch) this.dispatched = true;
      return Promise.resolve()
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
    });
    return Promise.race([task, this.confirmation]);
  }

  claim(): { value: Result } | undefined {
    if (!this.result || this.claimed) return;
    this.claimed = true;
    return this.result;
  }
}
