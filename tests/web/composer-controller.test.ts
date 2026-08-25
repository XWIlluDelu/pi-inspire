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
  const deleteAttachment = vi.fn().mockResolvedValue(undefined);
  let generation = 0;
  let api = { prompt, uploadAttachments, deleteAttachment } as unknown as Api;
  const patch = vi.fn();
  const notify = vi.fn();
  const clearVisibleError = vi.fn();
  const failVisible = vi.fn();
  const controller = new ComposerController({
    state: () => ({ sessionId: activeSessionId }),
    api: () => api,
    transportGeneration: () => generation,
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
    deleteAttachment,
    replaceTransport: (replacement?: Api) => {
      generation += 1;
      api = replacement ?? api;
      controller.invalidateForTransportReplacement();
    },
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

    await expect(sending).resolves.toEqual({
      accepted: true,
      historyEntry: null,
    });
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

  it("temporarily replaces and restores complete recalled prompt artifacts", async () => {
    const harness = createHarness();
    harness.uploadAttachments.mockResolvedValue({
      attachments: [{ id: "draft-file", fileName: "draft.txt", kind: "file" }],
    });
    await harness.controller.addFiles([
      new File(["draft"], "draft.txt", { type: "text/plain" }),
    ]);
    harness.controller.addProjectFile("/workspace/draft.ts");
    const scope = {
      sessionId: "session-a",
      viewId: "view-a",
      incarnation: "projection-a",
      effectiveLeafId: "leaf-a",
    };
    const entry = {
      text: "recalled",
      images: [
        {
          reference: "pi-embedded://4/1",
          mimeType: "image/png",
          size: 12,
        },
      ],
      files: [
        {
          reference: "pi-file://4/0",
          fileName: "report.pdf",
          kind: "attachment" as const,
        },
        {
          reference: "pi-file://4/1",
          fileName: "source.ts",
          kind: "project" as const,
        },
      ],
    };

    harness.controller.previewHistoryEntry(scope, entry);
    expect(harness.slice()).toMatchObject({
      attachments: [
        {
          kind: "image",
          recalledArtifact: {
            type: "image",
            reference: "pi-embedded://4/1",
            preview: true,
          },
        },
        {
          fileName: "report.pdf",
          recalledArtifact: {
            type: "file",
            reference: "pi-file://4/0",
            fileKind: "attachment",
          },
        },
        {
          fileName: "source.ts",
          recalledArtifact: {
            type: "file",
            reference: "pi-file://4/1",
            fileKind: "project",
          },
        },
      ],
      projectFiles: [],
    });
    harness.controller.cancelHistoryPreview("session-a");
    expect(harness.slice()).toMatchObject({
      attachments: [{ uploadedId: "draft-file", kind: "file" }],
      projectFiles: ["/workspace/draft.ts"],
    });

    harness.controller.previewHistoryEntry(scope, entry);
    harness.prompt.mockRejectedValue(new Error("network lost"));
    await expect(harness.controller.send("recalled")).resolves.toBe(false);
    expect(harness.prompt).toHaveBeenCalledWith({
      sessionId: "session-a",
      message: "recalled",
      historyArtifacts: {
        viewId: "view-a",
        incarnation: "projection-a",
        effectiveLeafId: "leaf-a",
        imageReferences: ["pi-embedded://4/1"],
        fileReferences: ["pi-file://4/0", "pi-file://4/1"],
      },
    });
    expect(harness.deleteAttachment).toHaveBeenCalledWith("draft-file");
    expect(harness.slice()).toMatchObject({
      attachments: [
        {
          recalledArtifact: {
            type: "image",
            reference: "pi-embedded://4/1",
            preview: false,
          },
        },
        {
          recalledArtifact: {
            type: "file",
            reference: "pi-file://4/0",
            preview: false,
          },
        },
        {
          recalledArtifact: {
            type: "file",
            reference: "pi-file://4/1",
            preview: false,
          },
        },
      ],
      projectFiles: [],
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

  it("cannot clear a composer after its transport was replaced", async () => {
    const pending = deferred<void>();
    const harness = createHarness();
    harness.prompt.mockReturnValue(pending.promise);
    harness.controller.addProjectFile("/workspace/kept.ts");

    const sending = harness.controller.send("send");
    harness.replaceTransport();
    pending.resolve();

    await expect(sending).resolves.toBe(false);
    expect(harness.slice()).toEqual({
      attachments: [],
      projectFiles: ["/workspace/kept.ts"],
      sending: false,
    });
    expect(harness.clearVisibleError).not.toHaveBeenCalled();
  });

  it("reclaims an upload that completes on a replaced transport", async () => {
    const pending = deferred<{
      attachments: Array<{ id: string; fileName: string; kind: "file" }>;
    }>();
    const harness = createHarness();
    harness.uploadAttachments.mockReturnValue(pending.promise);

    const uploading = harness.controller.addFiles([
      new File(["late"], "late.txt", { type: "text/plain" }),
    ]);
    harness.replaceTransport();
    pending.resolve({
      attachments: [{ id: "late-file", fileName: "late.txt", kind: "file" }],
    });
    await uploading;

    expect(harness.deleteAttachment).toHaveBeenCalledWith("late-file");
    expect(harness.slice().attachments).toEqual([
      expect.objectContaining({ status: "error" }),
    ]);
  });
});
