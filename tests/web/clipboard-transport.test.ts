// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopySource } from "../../src/content-copy";
import { deferred } from "./helpers";

class TestClipboardItem {
  readonly types: string[];
  constructor(readonly data: Record<string, Blob | Promise<Blob>>) {
    this.types = Object.keys(data);
  }
  getType(type: string): Promise<Blob> {
    return Promise.resolve(this.data[type]!);
  }
}

afterEach(() => vi.unstubAllGlobals());

async function transport(granted = false) {
  vi.resetModules();
  const committed: Array<Record<string, Blob>> = [];
  const write = vi.fn(async (items: TestClipboardItem[]) => {
    const entry = Object.fromEntries(
      await Promise.all(
        items[0]!.types.map(async (type) => [
          type,
          await items[0]!.getType(type),
        ]),
      ),
    );
    committed.push(entry);
  });
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", {
    clipboard: { write, writeText },
    ...(granted
      ? { permissions: { query: async () => ({ state: "granted" }) } }
      : {}),
  });
  vi.stubGlobal("ClipboardItem", TestClipboardItem);
  const module = await import("../../src/content-copy");
  await Promise.resolve();
  return { ...module, committed, write, writeText };
}
const png = (size: number) =>
  new Blob(["x".repeat(size)], { type: "image/png" });

describe("gesture-bound clipboard transport", () => {
  it("requests the clipboard synchronously but resolves data only after the complete source loads", async () => {
    const { writeCopyContent, copyLoader, write, committed } =
      await transport();
    const read = deferred<CopySource | null>();
    const result = writeCopyContent(
      copyLoader(() => read.promise, { text: true, image: true }),
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(committed).toEqual([]);
    const item = write.mock.calls[0]![0][0]!;
    expect(item.data["text/plain"]).toBeInstanceOf(Promise);
    expect(item.data["image/png"]).toBeInstanceOf(Promise);
    const first = png(1);
    read.resolve({ text: "caption", images: [first, png(2)] });
    expect(await result).toBe(true);
    expect(committed).toEqual([
      { "image/png": first, "text/plain": expect.any(Blob) },
    ]);
    expect(committed[0]!["text/plain"]!.size).toBe(7);
  });

  it("never resolves a partial format if any image fails preparation", async () => {
    const { writeCopyContent, copyLoader, committed } = await transport();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockRejectedValue(new Error("Image decode failed")),
    );
    await expect(
      writeCopyContent(
        copyLoader(
          async () => ({
            text: "complete caption",
            images: [png(1), new Blob(["bad"], { type: "image/jpeg" })],
          }),
          { text: true, image: true },
        ),
      ),
    ).rejects.toThrow("Image decode failed");
    expect(committed).toEqual([]);
  });

  it("retires an older read across different controls before a later immediate-text write", async () => {
    const { writeCopyContent, copyLoader, committed, writeText } =
      await transport();
    const read = deferred<CopySource | null>();
    let signal: AbortSignal | undefined;
    const old = writeCopyContent(
      copyLoader((owner) => {
        signal = owner;
        return read.promise;
      }),
    );
    expect(await writeCopyContent("new intent")).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(await old).toBe(false);
    read.resolve("old bytes");
    await read.promise;
    expect(writeText).toHaveBeenCalledExactlyOnceWith("new intent");
    expect(committed).toEqual([]);
  });

  it("cancels both promised formats when their source view changes", async () => {
    const { writeCopyContent, copyLoader, committed } = await transport();
    const read = deferred<CopySource | null>();
    let current = true;
    const result = writeCopyContent(
      copyLoader(() => read.promise),
      () => current,
    );
    current = false;
    read.resolve("stale view");
    expect(await result).toBe(false);
    expect(committed).toEqual([]);
  });

  it("uses reverse history writes only with explicit background permission", async () => {
    const { writeCopyContent, copyLoader, committed, write } =
      await transport(true);
    const images = [png(1), png(2), png(3)];
    expect(
      await writeCopyContent(
        copyLoader(async () => ({ text: "caption", images }), {
          text: true,
          image: true,
        }),
      ),
    ).toBe(true);
    expect(committed.map((entry) => entry["image/png"]!.size)).toEqual([
      3, 2, 1,
    ]);
    expect(committed.map((entry) => entry["text/plain"]?.size)).toEqual([
      undefined,
      undefined,
      7,
    ]);
    expect(
      write.mock.calls.every(
        ([items]) => items[0]!.data["image/png"] instanceof Blob,
      ),
    ).toBe(true);
  });

  it("rejects changed formats before publishing any data", async () => {
    const { writeCopyContent, copyLoader, committed } = await transport();
    await expect(
      writeCopyContent(
        copyLoader(async () => ({ text: "", images: [png(1)] })),
      ),
    ).rejects.toThrow("The copy source changed");
    expect(committed).toEqual([]);
  });

  it("aborts the source after early permission rejection without replacing its error", async () => {
    const { writeCopyContent, copyLoader, write, committed } =
      await transport();
    const read = deferred<CopySource | null>();
    let signal: AbortSignal | undefined;
    write.mockRejectedValue(new Error("permission denied"));
    await expect(
      writeCopyContent(
        copyLoader((owner) => {
          signal = owner;
          return read.promise;
        }),
      ),
    ).rejects.toThrow("permission denied");
    expect(signal?.aborted).toBe(true);
    read.reject(new Error("later read aborted"));
    await expect(read.promise).rejects.toThrow("later read aborted");
    expect(committed).toEqual([]);
  });

  it("keeps immediate text available without ClipboardItem and treats missing sources as cancelled", async () => {
    const { writeCopyContent, copyLoader, writeText, committed } =
      await transport();
    vi.stubGlobal("ClipboardItem", undefined);
    const result = writeCopyContent("ready text");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("ready text");
    expect(await result).toBe(true);
    expect(await writeCopyContent(copyLoader(async () => null))).toBe(false);
    expect(committed).toEqual([]);
  });
});
