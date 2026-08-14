import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api";
import {
  ComposerController,
  type ComposerSlice,
} from "../../src/controllers/composer-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createHarness(sessionId = "session-a") {
  let activeSessionId: string | null = sessionId;
  const prompt = vi.fn();
  const uploadAttachments = vi.fn();
  const deleteAttachment = vi.fn();
  const api = { prompt, uploadAttachments, deleteAttachment } as unknown as Api;
  const patch = vi.fn();
  const notify = vi.fn();
  const clearVisibleError = vi.fn();
  const failVisible = vi.fn();
  const controller = new ComposerController({
    state: () => ({ sessionId: activeSessionId }),
    api: () => api,
    patch,
    notify,
    clearVisibleError: (owner) => {
      if (activeSessionId === owner) clearVisibleError();
    },
    failVisible: (owner, message) => {
      if (activeSessionId === owner) failVisible(message);
    },
  });
  return {
    controller,
    prompt,
    uploadAttachments,
    patch,
    notify,
    clearVisibleError,
    failVisible,
    activate: (id: string | null) => {
      activeSessionId = id;
    },
    slice: (id = sessionId): ComposerSlice => controller.slice(id),
  };
}

describe("ComposerController", () => {
  it("clears only the delivered partition and preserves an attachment staged during send", async () => {
    const pending = deferred<void>();
    const harness = createHarness();
    harness.prompt.mockReturnValue(pending.promise);
    harness.uploadAttachments.mockResolvedValue({
      attachments: [{ id: "next-file", fileName: "next.txt", kind: "file" }],
    });
    harness.controller.addProjectFile("/workspace/sent.ts");

    const sending = harness.controller.send("inspect this");
    await harness.controller.addFiles([
      new File(["next"], "next.txt", { type: "text/plain" }),
    ]);
    pending.resolve();

    await expect(sending).resolves.toBe(true);
    expect(harness.prompt).toHaveBeenCalledWith({
      sessionId: "session-a",
      message: "inspect this",
      projectFiles: ["/workspace/sent.ts"],
    });
    expect(harness.slice()).toEqual({
      attachments: [
        expect.objectContaining({
          uploadedId: "next-file",
          status: "ready",
        }),
      ],
      projectFiles: [],
      sending: false,
    });
  });

  it("keeps a failed prompt error scoped to the session that sent it", async () => {
    const harness = createHarness();
    harness.prompt.mockRejectedValue(new Error("network lost"));
    harness.controller.addProjectFile("/workspace/message.ts");

    const sending = harness.controller.send("send");
    harness.activate("session-b");

    await expect(sending).resolves.toBe(false);
    expect(harness.failVisible).not.toHaveBeenCalled();
    expect(harness.slice()).toEqual({
      attachments: [],
      projectFiles: ["/workspace/message.ts"],
      sending: false,
    });
  });

  it("refuses prompt delivery while an attachment remains in an error state", async () => {
    const harness = createHarness();
    harness.uploadAttachments.mockRejectedValue(new Error("upload failed"));
    await harness.controller.addFiles([
      new File(["broken"], "broken.txt", { type: "text/plain" }),
    ]);

    await expect(harness.controller.send("send")).resolves.toBe(false);
    expect(harness.notify).toHaveBeenCalledWith(
      "warning",
      "Remove failed attachments before sending",
    );
    expect(harness.prompt).not.toHaveBeenCalled();
  });
});
