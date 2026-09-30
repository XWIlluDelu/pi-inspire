import type { Root } from "hast";
import type {
  RichTextParseRequest,
  RichTextParseResponse,
} from "./rich-text-parser";

export interface RichTextSnapshot {
  text: string;
  headings: boolean;
  tree: Root;
}

interface ParseJob {
  owner: object;
  request: RichTextParseRequest;
  complete(snapshot: RichTextSnapshot): void;
  fail(error: Error): void;
  cancelled: boolean;
}

/** One shared worker, one active parse, and at most one latest pending source
 * per mounted reader. Completed prefixes can render while the latest job waits. */
export class RichTextParserClient {
  private worker: Worker | null = null;
  private active: ParseJob | null = null;
  private readonly pending = new Map<object, ParseJob>();
  private readonly owners = new Set<object>();
  private nextId = 0;

  constructor(
    private readonly createWorker = () =>
      new Worker(new URL("./rich-text-worker.ts", import.meta.url), {
        type: "module",
      }),
  ) {}

  parse(
    owner: object,
    text: string,
    headings: boolean,
    complete: ParseJob["complete"],
    fail: ParseJob["fail"],
  ): void {
    this.owners.add(owner);
    this.pending.set(owner, {
      owner,
      request: { id: ++this.nextId, text, headings },
      complete,
      fail,
      cancelled: false,
    });
    this.pump();
  }

  release(owner: object): void {
    this.owners.delete(owner);
    this.pending.delete(owner);
    if (this.active?.owner === owner) this.active.cancelled = true;
    if (this.owners.size === 0) {
      this.worker?.terminate();
      this.worker = null;
      this.active = null;
    }
  }

  private pump(): void {
    if (this.active || this.pending.size === 0) return;
    const [owner, job] = this.pending.entries().next().value!;
    this.pending.delete(owner);
    this.active = job;
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.onmessage = (event: MessageEvent<RichTextParseResponse>) => {
          const active = this.active;
          if (
            this.worker !== worker ||
            !active ||
            event.data.id !== active.request.id
          )
            return;
          this.active = null;
          if (!active.cancelled && this.owners.has(active.owner)) {
            if ("tree" in event.data)
              active.complete({
                text: active.request.text,
                headings: active.request.headings,
                tree: event.data.tree,
              });
            else if (!this.pending.has(active.owner))
              active.fail(new Error(event.data.error));
          }
          this.pump();
        };
        worker.onerror = (event) => {
          if (this.worker === worker)
            this.fail(
              new Error(event.message || "Markdown parser worker failed"),
            );
        };
        worker.onmessageerror = () => {
          if (this.worker === worker)
            this.fail(
              new Error("Markdown parser worker returned an unreadable result"),
            );
        };
      }
      this.worker.postMessage(job.request);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    const jobs = new Map(this.pending);
    if (this.active && !jobs.has(this.active.owner))
      jobs.set(this.active.owner, this.active);
    this.active = null;
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    for (const job of jobs.values())
      if (!job.cancelled && this.owners.has(job.owner)) job.fail(error);
  }
}

export const richTextParser = new RichTextParserClient();
