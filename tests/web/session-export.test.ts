// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { Api } from "../../src/api";
import { AppStore } from "../../src/store";
import { deferred } from "./helpers";

afterEach(() => vi.restoreAllMocks());

it("keeps a replacement export pending when a retired request finishes, then reports the current failure", async () => {
  const store = new AppStore();
  const oldResult = deferred<{ downloadId: string; fileName: string }>();
  const currentResult = deferred<{ downloadId: string; fileName: string }>();
  const oldApi = {
    exportSession: vi.fn(() => oldResult.promise),
    exportDownload: vi.fn(async () => new Blob(["old history"])),
  };
  const currentApi = { exportSession: vi.fn(() => currentResult.promise) };
  const internal = store as unknown as { api: Api };
  internal.api = oldApi as unknown as Api;
  const oldExport = store
    .exportSession("s1", "html")
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(oldApi.exportSession).toHaveBeenCalledOnce());
  internal.api = currentApi as unknown as Api;
  const currentExport = store
    .exportSession("s1", "jsonl")
    .catch((error: unknown) => error);
  oldResult.resolve({ downloadId: "old", fileName: "old.html" });
  expect(await oldExport).toMatchObject({
    message: "The Host connection changed during export",
  });
  expect(store.getState().exportingSessions).toEqual({ s1: "jsonl" });
  expect(store.getState().notices).toEqual([]);
  currentResult.reject(new Error("Export storage unavailable"));
  expect(await currentExport).toMatchObject({
    message: "Export storage unavailable",
  });
  expect(store.getState().exportingSessions).toEqual({});
  expect(store.getState().notices).toMatchObject([
    { kind: "error", text: "Export storage unavailable" },
  ]);
});
