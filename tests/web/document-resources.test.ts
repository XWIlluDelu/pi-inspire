import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  documentResourceReference,
  DocumentImageResources,
} from "../../src/document-resources";
import { deferred } from "./helpers";

const document = {
  reference: "README.md",
  workspacePath: "reports/run/README.md",
};

describe("document-relative resources", () => {
  it.each([
    ["plot.png", "./reports/run/plot.png"],
    ["./plot.png", "./reports/run/./plot.png"],
    ["../figures/plot%20one.svg", "./reports/run/../figures/plot%20one.svg"],
    ["../guide.md#results", "./reports/run/../guide.md#results"],
    ["LICENSE", "./reports/run/LICENSE"],
    ["/tmp/plot.png", "/tmp/plot.png"],
    ["file:///tmp/plot.png", "file:///tmp/plot.png"],
    ["C:\\reports\\plot.png", "C:\\reports\\plot.png"],
    ["#results", null],
    ["https://example.invalid/plot.png", null],
    ["//example.invalid/plot.png", null],
    ["\\\\example.invalid\\plot.png", null],
    ["data:image/png;base64,AAAA", null],
    ["blob:other-document", null],
    ["javascript:alert(1)", null],
    ["attachment:plot.png", null],
  ])("resolves %s without turning URLs into host paths", (target, expected) => {
    expect(documentResourceReference(document, target)).toBe(expected);
  });

  it("uses the actual recovered location, encodes literal paths once, and disables bare-name recovery", () => {
    expect(
      documentResourceReference(
        {
          reference: "README.md",
          workspacePath: "reports #1/100%25/README.md",
        },
        "plot%23one.png",
      ),
    ).toBe("./reports%20%231/100%2525/plot%23one.png");
    expect(
      documentResourceReference({ reference: "README.md" }, "missing.png"),
    ).toBe("./missing.png");
    expect(
      documentResourceReference(
        { reference: "file:///tmp/report%20one/README.md#part" },
        "../plot.png",
      ),
    ).toBe("file:///tmp/report%20one/../plot.png");
  });
});

describe("document image ownership and budgets", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => `blob:${Math.random()}`,
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("deduplicates images, bounds concurrent transfers, and revokes the document's URLs", async () => {
    const gate = deferred<Blob>();
    const fetchImage = vi.fn(() => gate.promise);
    const owner = new DocumentImageResources(fetchImage);
    const first = owner.load("one.png");
    expect(owner.load("one.png")).toBe(first);
    const rest = Array.from({ length: 6 }, (_, n) => owner.load(`${n}.png`));
    expect(fetchImage).toHaveBeenCalledTimes(4);
    gate.resolve(new Blob(["image"]));
    await Promise.all([first, ...rest]);
    expect(fetchImage).toHaveBeenCalledTimes(7);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(7);
    owner.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(7);
  });

  it("aborts running work, retires queued work, and rejects late successes without allocating URLs", async () => {
    const gate = deferred<Blob>();
    const fetchImage = vi.fn(
      (_reference: string, _signal: AbortSignal) => gate.promise,
    );
    const owner = new DocumentImageResources(fetchImage);
    const settled = Promise.allSettled(
      Array.from({ length: 8 }, (_, n) => owner.load(`${n}.png`)),
    );
    owner.dispose();
    expect(fetchImage.mock.calls.every(([, signal]) => signal.aborted)).toBe(
      true,
    );
    gate.resolve(new Blob(["late"]));
    expect(
      (await settled).every((result) => result.status === "rejected"),
    ).toBe(true);
    expect(fetchImage).toHaveBeenCalledTimes(4);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("caps distinct images and retained image bytes", async () => {
    const owner = new DocumentImageResources(async () => new Blob());
    await Promise.all(
      Array.from({ length: 64 }, (_, n) => owner.load(`${n}.png`)),
    );
    await expect(owner.load("overflow.png")).rejects.toThrow("limit reached");
    owner.dispose();
    const blob = new Blob();
    Object.defineProperty(blob, "size", { value: 32 * 1024 * 1024 });
    const large = new DocumentImageResources(async () => blob);
    await large.load("first.png");
    await large.load("second.png");
    await expect(large.load("third.png")).rejects.toThrow("limit reached");
    large.dispose();
  });
});
