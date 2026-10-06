import { describe, expect, it, vi } from "vitest";
import type {
  RichTextParseRequest,
  RichTextParseResponse,
} from "../../src/rich-text-parser";
import { RichTextParserClient } from "../../src/rich-text-parser-client";

class ParserWorker {
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  readonly requests: RichTextParseRequest[] = [];
  terminate = vi.fn();
  postMessage(request: RichTextParseRequest) {
    this.requests.push(request);
  }
  reply(response: RichTextParseResponse) {
    this.onmessage?.call(
      this as unknown as Worker,
      new MessageEvent("message", { data: response }),
    );
  }
  finish(index: number) {
    this.reply({
      id: this.requests[index]!.id,
      tree: { type: "root", children: [] },
    });
  }
  crash() {
    this.onerror?.call(
      this as unknown as Worker,
      { message: "worker failed" } as ErrorEvent,
    );
  }
}
const callbacks = () => ({ complete: vi.fn(), fail: vi.fn() });
function fixture() {
  const workers: ParserWorker[] = [];
  const client = new RichTextParserClient(() => {
    const worker = new ParserWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  return { client, workers };
}

describe("Markdown parser ownership", () => {
  it("shares one worker and retains only the latest queued source per reader", () => {
    const { client, workers } = fixture();
    const owner = {},
      other = {};
    const one = callbacks(),
      two = callbacks();
    client.parse(owner, "active", false, one.complete, one.fail);
    client.parse(owner, "obsolete", false, one.complete, one.fail);
    client.parse(other, "other reader", true, two.complete, two.fail);
    client.parse(owner, "latest", false, one.complete, one.fail);
    expect(workers).toHaveLength(1);
    const worker = workers[0]!;
    expect(worker.requests.map((request) => request.text)).toEqual(["active"]);
    worker.finish(0);
    expect(one.complete).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "active" }),
    );
    expect(worker.requests[1]?.text).toBe("latest");
    worker.finish(1);
    expect(worker.requests[2]).toMatchObject({
      text: "other reader",
      headings: true,
    });
    worker.finish(2);
    expect(one.complete).toHaveBeenCalledTimes(2);
    expect(two.complete).toHaveBeenCalledOnce();
    client.release(owner);
    client.release(other);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("retires a released active reader and starts valid work without waiting for it", () => {
    const { client, workers } = fixture();
    const transcript = {},
      document = {},
      replacement = {};
    const retained = callbacks(),
      retired = callbacks(),
      current = callbacks();
    client.parse(
      transcript,
      "transcript",
      false,
      retained.complete,
      retained.fail,
    );
    workers[0]!.finish(0);
    client.parse(
      document,
      "old document",
      true,
      retired.complete,
      retired.fail,
    );
    client.parse(document, "queued edit", true, retired.complete, retired.fail);
    client.parse(
      replacement,
      "new document",
      true,
      current.complete,
      current.fail,
    );
    client.release(document);

    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(workers[1]!.requests.map((request) => request.text)).toEqual([
      "new document",
    ]);
    workers[0]!.finish(1);
    workers[0]!.crash();
    expect(retired.complete).not.toHaveBeenCalled();
    expect(retired.fail).not.toHaveBeenCalled();
    expect(current.fail).not.toHaveBeenCalled();
    workers[1]!.finish(0);
    expect(current.complete).toHaveBeenCalledOnce();
    expect(retained.complete).toHaveBeenCalledOnce();
    expect(retained.fail).not.toHaveBeenCalled();
    client.release(replacement);
    client.release(transcript);
    expect(workers[1]!.terminate).toHaveBeenCalledOnce();
  });

  it("continues with the latest source after an obsolete parse fails", () => {
    const { client, workers } = fixture();
    const owner = {},
      result = callbacks();
    client.parse(owner, "old", false, result.complete, result.fail);
    client.parse(owner, "current", false, result.complete, result.fail);
    const worker = workers[0]!;
    worker.reply({
      id: worker.requests[0]!.id,
      error: "obsolete source error",
    });
    expect(result.fail).not.toHaveBeenCalled();
    worker.finish(1);
    expect(result.complete).toHaveBeenCalledWith(
      expect.objectContaining({ text: "current" }),
    );
    client.parse(owner, "bad", false, result.complete, result.fail);
    worker.reply({ id: worker.requests[2]!.id, error: "current source error" });
    expect(result.fail).toHaveBeenCalledWith(
      expect.objectContaining({ message: "current source error" }),
    );
    client.release(owner);
  });

  it("reports a worker failure once to each current reader and releases its queue", () => {
    const { client, workers } = fixture();
    const owner = {},
      other = {};
    const one = callbacks(),
      two = callbacks();
    client.parse(owner, "active", false, one.complete, one.fail);
    client.parse(owner, "newer", false, one.complete, one.fail);
    client.parse(other, "other", false, two.complete, two.fail);
    workers[0]!.crash();
    expect(one.fail).toHaveBeenCalledOnce();
    expect(two.fail).toHaveBeenCalledOnce();
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    workers[0]!.finish(0);
    expect(one.complete).not.toHaveBeenCalled();
    client.release(owner);
    client.release(other);
  });
});
