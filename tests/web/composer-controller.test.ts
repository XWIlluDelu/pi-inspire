import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptAcceptedResponse } from "../../shared/contracts";
import { type Api, ApiError, ApiTransportError } from "../../src/api";
import {
  ComposerController,
  type ComposerSlice,
} from "../../src/controllers/composer-controller";
import { deferred } from "./helpers";

function createHarness(sessionId = "session-a") {
  let activeSessionId: string | null = sessionId;
  const prompt = vi.fn();
  const uploadAttachments = vi.fn();
  const deleteAttachment = vi.fn().mockResolvedValue(undefined);
  let authorityId = "11111111-1111-4111-8111-111111111111";
  let api = {
    prompt,
    uploadAttachments,
    deleteAttachment,
    attachmentPreview: vi
      .fn()
      .mockRejectedValue(new Error("Preview unavailable")),
  } as unknown as Api;
  const patch = vi.fn();
  const notify = vi.fn();
  const notifyVisible = vi.fn();
  const handleAuthFailure = vi.fn();
  const restoreDraftIfEmpty = vi.fn().mockReturnValue(true);
  const controller = new ComposerController({
    state: () => ({ sessionId: activeSessionId, transcriptViewId: null }),
    api: () => api,
    authorityId: () => authorityId,
    patch,
    notify,
    handleAuthFailure,
    restoreDraftIfEmpty,
    notifyVisible: (owner, message) => {
      if (activeSessionId === owner) notifyVisible(message);
    },
  });
  return {
    controller,
    prompt,
    uploadAttachments,
    patch,
    notify,
    notifyVisible,
    handleAuthFailure,
    restoreDraftIfEmpty,
    deleteAttachment,
    replaceTransport: (replacement?: Api) => {
      api = replacement ?? { ...api };
      controller.invalidateForTransportReplacement();
    },
    replaceAuthority: (replacement: string) => {
      authorityId = replacement;
      api = { ...api };
      controller.invalidateForTransportReplacement();
    },
    activate: (id: string | null) => {
      activeSessionId = id;
    },
    slice: (id = sessionId): ComposerSlice => controller.slice(id),
  };
}

const acceptedPrompt: PromptAcceptedResponse = {
  accepted: true,
  historyEntry: null,
};

describe("ComposerController", () => {
  afterEach(() => vi.useRealTimers());
  it("deduplicates each image in a handoff after a draft is removed, not the handle forever", () => {
    const f = createHarness();
    const authority = "11111111-1111-4111-8111-111111111111";
    f.controller.reconcileAuthority(authority);
    const image = (id: string) => ({
      id,
      fileName: id + ".png",
      mimeType: "image/png",
      size: 4,
      kind: "image" as const,
    });
    f.controller.restoreStagedAttachments(
      "session-a",
      [image("a")],
      authority,
      "first",
    );
    f.controller.removeAttachment(f.slice().attachments[0]!.localId);
    expect(f.slice().attachments).toEqual([]);
    f.controller.restoreStagedAttachments(
      "session-a",
      [image("a"), image("b")],
      authority,
      "first",
    );
    expect(f.slice().attachments.map((item) => item.uploadedId)).toEqual(["b"]);
    f.controller.restoreStagedAttachments(
      "session-a",
      [image("a")],
      authority,
      "next",
    );
    expect(f.slice().attachments.map((item) => item.uploadedId)).toEqual([
      "a",
      "b",
    ]);
  });

  it.each(["refused", "unknown"] as const)(
    "hands off independent prompts and restores the %s input without replacing later work",
    async (outcome) => {
      const f = createHarness();
      const first = deferred<PromptAcceptedResponse>();
      const second = deferred<PromptAcceptedResponse>();
      f.prompt
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockResolvedValue(acceptedPrompt);
      const handedOff = vi.fn();
      f.controller.addProjectFile("/workspace/first.ts");
      const firstSend = f.controller.send("first", "steer", handedOff);
      expect(handedOff).toHaveBeenCalledOnce();
      f.controller.addProjectFile("/workspace/second.ts");
      const secondSend = f.controller.send("second", "followUp", handedOff);
      expect(handedOff).toHaveBeenCalledTimes(2);
      const [firstRequest, secondRequest] = f.prompt.mock.calls.map(
        ([request]) => request,
      );
      expect(firstRequest.projectFiles).toEqual(["/workspace/first.ts"]);
      expect(secondRequest.projectFiles).toEqual(["/workspace/second.ts"]);
      expect(f.slice().projectFiles).toEqual([]);
      f.restoreDraftIfEmpty.mockReturnValue(false);
      first.reject(
        outcome === "unknown"
          ? new ApiTransportError("request", true)
          : new ApiError(409, "not delivered"),
      );
      await expect(firstSend).resolves.toBe(false);
      expect(f.slice().failedDeliveryCount).toBe(1);
      second.resolve(acceptedPrompt);
      await secondSend;
      f.restoreDraftIfEmpty.mockReturnValue(true);
      expect(f.controller.restoreFailedPrompt("session-a")).toBe(true);
      expect(f.restoreDraftIfEmpty).toHaveBeenLastCalledWith(
        "session-a",
        "first",
      );
      expect(f.slice().projectFiles).toEqual(["/workspace/first.ts"]);
      if (outcome === "unknown") {
        await f.controller.send("first");
        expect(f.prompt.mock.calls[2]![0]).toEqual(firstRequest);
      }
    },
  );

  it.each(["PROMPT_RECOVERED", "PROMPT_CLEARED"] as const)(
    "applies the Host's %s outcome to the original draft without restoring the text again",
    async (code) => {
      const response = deferred<PromptAcceptedResponse>();
      const f = createHarness();
      f.prompt.mockReturnValue(response.promise);
      f.uploadAttachments.mockResolvedValue({
        attachments: [
          {
            id: "image",
            fileName: "image.png",
            kind: "image",
            mimeType: "image/png",
            size: 4,
          },
        ],
      });
      await f.controller.addFiles([
        new File(["data"], "image.png", { type: "image/png" }),
      ]);
      f.controller.addProjectFile("/workspace/pending.ts");
      const sending = f.controller.send("pending input", "steer");
      f.controller.addProjectFile("/workspace/new-draft.ts");
      f.activate("session-b");
      response.reject(
        new ApiError(409, "Pending input changed", undefined, code),
      );

      await expect(sending).resolves.toBe(false);
      const recovered = code === "PROMPT_RECOVERED";
      expect(f.slice("session-a")).toEqual({
        projectFiles: recovered
          ? ["/workspace/pending.ts", "/workspace/new-draft.ts"]
          : ["/workspace/new-draft.ts"],
        attachments: recovered
          ? [expect.objectContaining({ uploadedId: "image", status: "ready" })]
          : [],
        failedDeliveryCount: 0,
      });
      expect(f.slice("session-b").attachments).toEqual([]);
      expect(f.restoreDraftIfEmpty).not.toHaveBeenCalled();
      if (recovered) expect(f.deleteAttachment).not.toHaveBeenCalled();
    },
  );

  it("preserves attachments and project files added during a send", async () => {
    const pending = deferred<PromptAcceptedResponse>();
    const harness = createHarness();
    harness.prompt.mockReturnValue(pending.promise);
    harness.uploadAttachments.mockResolvedValue({
      attachments: [{ id: "next-file", fileName: "next.txt", kind: "file" }],
    });
    harness.controller.addProjectFile("/workspace/sent.ts");

    const sending = harness.controller.send("inspect this");
    expect(harness.slice().projectFiles).toEqual([]);
    harness.controller.addProjectFile("/workspace/next.ts");
    await harness.controller.addFiles([
      new File(["next"], "next.txt", { type: "text/plain" }),
    ]);
    pending.resolve(acceptedPrompt);

    await expect(sending).resolves.toEqual({
      accepted: true,
      historyEntry: null,
    });
    expect(harness.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        message: "inspect this",
        projectFiles: ["/workspace/sent.ts"],
      }),
      expect.any(AbortSignal),
    );
    expect(harness.slice()).toEqual({
      attachments: [
        expect.objectContaining({
          uploadedId: "next-file",
          status: "ready",
        }),
      ],
      projectFiles: ["/workspace/next.ts"],
      failedDeliveryCount: 0,
    });
  });

  it.each([
    "background transport failure",
    "current authorization failure",
  ] as const)(
    "keeps the draft in its own session after a %s",
    async (reason) => {
      const f = createHarness();
      const expired = reason === "current authorization failure";
      f.prompt.mockRejectedValue(
        expired
          ? new ApiError(401, "expired token")
          : new ApiTransportError("request"),
      );
      f.controller.addProjectFile("/workspace/message.ts");

      const sending = f.controller.send("send");
      if (!expired) f.activate("session-b");

      await expect(sending).resolves.toBe(false);
      expect(f.handleAuthFailure).toHaveBeenCalledTimes(expired ? 1 : 0);
      expect(f.notifyVisible).not.toHaveBeenCalled();
      expect(f.slice("session-a")).toEqual({
        attachments: [],
        projectFiles: ["/workspace/message.ts"],
        failedDeliveryCount: 0,
      });
    },
  );

  it("retires confirmation polling without cancelling or losing the delivery", async () => {
    const harness = createHarness();
    const pending = deferred<PromptAcceptedResponse>();
    const retry = deferred<PromptAcceptedResponse>();
    harness.prompt
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(retry.promise)
      .mockResolvedValueOnce(acceptedPrompt);
    harness.controller.addProjectFile("/workspace/kept.ts");
    const sending = harness.controller.send("synthetic prompt");
    const [first, signal] = harness.prompt.mock.calls[0]!;
    harness.replaceTransport();
    expect(signal.aborted).toBe(true);
    expect(harness.slice().projectFiles).toEqual(["/workspace/kept.ts"]);
    const retrying = harness.controller.send("synthetic prompt");
    const [retryRequest, retrySignal] = harness.prompt.mock.calls[1]!;
    expect(retryRequest).toEqual(first);
    pending.resolve(acceptedPrompt);
    await expect(sending).resolves.toBe(false);
    expect(retrySignal.aborted).toBe(false);
    harness.replaceTransport();
    expect(retrySignal.aborted).toBe(true);
    retry.resolve(acceptedPrompt);
    await expect(retrying).resolves.toBe(false);
    await expect(harness.controller.send("synthetic prompt")).resolves.toEqual(
      acceptedPrompt,
    );
    expect(harness.prompt.mock.calls[2]![0]).toEqual(first);
  });

  it("starts a new operation after a definitive same-Host 5xx refusal", async () => {
    const harness = createHarness();
    harness.prompt
      .mockRejectedValueOnce(
        new ApiError(
          500,
          "Host refused the prompt",
          undefined,
          undefined,
          undefined,
          "11111111-1111-4111-8111-111111111111",
        ),
      )
      .mockResolvedValueOnce({ accepted: true, historyEntry: null });

    await expect(harness.controller.send("try again")).resolves.toBe(false);
    await expect(harness.controller.send("try again")).resolves.toEqual({
      accepted: true,
      historyEntry: null,
    });

    expect(harness.prompt.mock.calls[1]![0].operationId).not.toBe(
      harness.prompt.mock.calls[0]![0].operationId,
    );
  });

  it("blocks one blind retry before creating a new identity after Host restart", async () => {
    const harness = createHarness();
    harness.prompt
      .mockRejectedValueOnce(new ApiTransportError("request"))
      .mockResolvedValueOnce({ accepted: true, historyEntry: null });

    await expect(harness.controller.send("inspect first")).resolves.toBe(false);
    const first = harness.prompt.mock.calls[0]![0];
    harness.replaceAuthority("22222222-2222-4222-8222-222222222222");

    await expect(harness.controller.send("inspect first")).resolves.toBe(false);
    expect(harness.prompt).toHaveBeenCalledTimes(1);
    expect(harness.notifyVisible).toHaveBeenLastCalledWith(
      expect.stringContaining("Check the conversation"),
    );

    await expect(harness.controller.send("inspect first")).resolves.toEqual({
      accepted: true,
      historyEntry: null,
    });
    const second = harness.prompt.mock.calls[1]![0];
    expect(second.operationId).not.toBe(first.operationId);
    expect(second.authorityId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("retains recalled artifacts after a refused send and releases the displaced draft", async () => {
    const f = createHarness();
    f.uploadAttachments.mockResolvedValue({
      attachments: [{ id: "draft-file", fileName: "draft.txt", kind: "file" }],
    });
    await f.controller.addFiles([new File(["draft"], "draft.txt")]);
    const reference = "pi-history-image://entry-4/1";
    f.controller.previewHistoryEntry(
      {
        sessionId: "session-a",
        viewId: "view-a",
        incarnation: "projection-a",
        effectiveLeafId: "leaf-a",
        historyVersion: "history-a",
      },
      {
        text: "recalled",
        images: [{ reference, mimeType: "image/png", size: 12 }],
        files: [],
      },
    );
    f.prompt.mockRejectedValue(new ApiError(409, "not delivered"));
    await expect(f.controller.send("recalled")).resolves.toBe(false);
    expect(f.deleteAttachment).toHaveBeenCalledWith("draft-file");
    expect(f.slice().attachments).toMatchObject([
      { recalledArtifact: { type: "image", reference, preview: false } },
    ]);
  });

  it.each(["staged", "history draft", "failed delivery"])(
    "restores a browser-held %s upload in its inactive partition after Host replacement",
    async (location) => {
      const harness = createHarness();
      harness.uploadAttachments.mockResolvedValue({
        attachments: [
          { id: "old-upload", fileName: "draft.txt", kind: "file" },
        ],
      });
      await harness.controller.addFiles([new File(["draft"], "draft.txt")]);
      if (location === "staged") {
        harness.replaceTransport();
        harness.controller.reconcileAuthority(
          "11111111-1111-4111-8111-111111111111",
        );
        harness.controller.resumeUploads();
        expect(harness.slice().attachments[0]).toMatchObject({
          status: "ready",
          uploadedId: "old-upload",
        });
        expect(harness.uploadAttachments).toHaveBeenCalledOnce();
      }
      if (location === "history draft") {
        harness.controller.previewHistoryEntry(
          {
            sessionId: "session-a",
            viewId: "view-a",
            incarnation: null,
            effectiveLeafId: null,
            historyVersion: "history-a",
          },
          { text: "recalled", images: [], files: [] },
        );
      } else if (location === "failed delivery") {
        harness.restoreDraftIfEmpty.mockReturnValue(false);
        harness.prompt.mockRejectedValue(new ApiError(409, "not sent"));
        await harness.controller.send("send");
      }
      harness.activate("session-b");
      const nextAuthority = "22222222-2222-4222-8222-222222222222";
      harness.uploadAttachments.mockResolvedValue({
        attachments: [
          { id: "new-upload", fileName: "draft.txt", kind: "file" },
        ],
      });
      harness.replaceAuthority(nextAuthority);
      harness.controller.reconcileAuthority(nextAuthority);
      harness.controller.resumeUploads();
      harness.controller.cancelHistoryPreview("session-a");
      harness.restoreDraftIfEmpty.mockReturnValue(true);
      harness.controller.restoreFailedPrompt("session-a");
      await vi.waitFor(() =>
        expect(harness.slice().attachments[0]).toMatchObject({
          status: "ready",
          uploadedId: "new-upload",
          uploadedAuthorityId: nextAuthority,
        }),
      );
      expect(harness.uploadAttachments.mock.calls[1]![0][0]).toBe(
        harness.uploadAttachments.mock.calls[0]![0][0],
      );
      expect(harness.slice("session-b").attachments).toEqual([]);
      harness.activate("session-a");
      harness.prompt.mockClear();
      harness.prompt.mockResolvedValue(acceptedPrompt);
      await expect(harness.controller.send("send")).resolves.toEqual(
        acceptedPrompt,
      );
      expect(harness.prompt.mock.calls[0]![0]).toMatchObject({
        authorityId: nextAuthority,
        attachmentIds: ["new-upload"],
      });
    },
  );

  it("restages only definitively expired files without replaying the refused prompt", async () => {
    const harness = createHarness();
    harness.uploadAttachments.mockResolvedValue({
      attachments: ["expired", "valid"].map((id) => ({
        id,
        fileName: `${id}.txt`,
        kind: "file",
      })),
    });
    await harness.controller.addFiles([
      new File(["old"], "expired.txt"),
      new File(["new"], "valid.txt"),
    ]);
    const replacement = deferred<{
      attachments: Array<{ id: string; fileName: string; kind: "file" }>;
    }>();
    harness.uploadAttachments.mockReturnValue(replacement.promise);
    harness.prompt.mockRejectedValue(
      new ApiError(
        409,
        "Attachments expired",
        ["expired"],
        "ATTACHMENTS_EXPIRED",
      ),
    );
    await expect(harness.controller.send("send")).resolves.toBe(false);
    expect(harness.slice().attachments.map((item) => item.status)).toEqual([
      "uploading",
      "ready",
    ]);
    expect(harness.uploadAttachments).toHaveBeenCalledTimes(2);
    expect(harness.uploadAttachments.mock.calls[1]![0]).toEqual([
      harness.uploadAttachments.mock.calls[0]![0][0],
    ]);
    await expect(harness.controller.send("send")).resolves.toBe(false);
    expect(harness.prompt).toHaveBeenCalledOnce();
    replacement.resolve({
      attachments: [{ id: "renewed", fileName: "expired.txt", kind: "file" }],
    });
    await vi.waitFor(() =>
      expect(harness.slice().attachments[0]?.status).toBe("ready"),
    );
    expect(harness.prompt).toHaveBeenCalledOnce();
    harness.prompt.mockResolvedValue(acceptedPrompt);
    await harness.controller.send("send");
    expect(harness.prompt.mock.calls[1]![0].attachmentIds).toEqual([
      "renewed",
      "valid",
    ]);
  });

  it.each(["refused", "incomplete"] as const)(
    "blocks delivery after a %s batch and reclaims any partial handles",
    async (outcome) => {
      const harness = createHarness();
      if (outcome === "incomplete") {
        harness.uploadAttachments.mockResolvedValue({
          attachments: [{ id: "partial", fileName: "one.txt", kind: "file" }],
        });
      } else {
        harness.uploadAttachments.mockRejectedValue(
          new ApiError(400, "Unsupported file"),
        );
      }
      await harness.controller.addFiles([
        new File(["one"], "one.txt", { type: "text/plain" }),
        new File(["two"], "two.txt", { type: "text/plain" }),
      ]);
      expect(harness.deleteAttachment.mock.calls).toEqual(
        outcome === "incomplete" ? [["partial"]] : [],
      );
      expect(harness.slice().attachments.map(({ status }) => status)).toEqual([
        "error",
        "error",
      ]);
      await expect(harness.controller.send("send")).resolves.toBe(false);
      expect(harness.notify).toHaveBeenCalledWith(
        "warning",
        "Retry or remove failed attachments before sending",
      );
      expect(harness.prompt).not.toHaveBeenCalled();
    },
  );

  it.each(["withdrawal", "retry"] as const)(
    "keeps a timed-out upload pending and handles %s without replaying the prompt",
    async (action) => {
      vi.useFakeTimers();
      const harness = createHarness();
      const file = new File(["retained"], "retained.txt");
      harness.uploadAttachments.mockRejectedValue(
        new ApiTransportError("request", true, true),
      );
      await harness.controller.addFiles([file]);
      const item = harness.slice().attachments[0]!;
      expect(item).toMatchObject({ status: "uploading", error: undefined });
      await expect(harness.controller.send("message")).resolves.toBe(false);

      if (action === "withdrawal") {
        harness.controller.removeAttachment(item.localId);
        await vi.advanceTimersByTimeAsync(14_000);
        expect(harness.uploadAttachments).toHaveBeenCalledOnce();
        expect(harness.prompt).not.toHaveBeenCalled();
        harness.prompt.mockResolvedValue(acceptedPrompt);
        await expect(harness.controller.send("message")).resolves.toEqual(
          acceptedPrompt,
        );
        return;
      }
      await vi.advanceTimersByTimeAsync(14_000);
      expect(harness.uploadAttachments).toHaveBeenCalledTimes(4);
      expect(harness.slice().attachments[0]).toMatchObject({
        status: "error",
        retryable: true,
      });
      harness.uploadAttachments.mockResolvedValue({
        attachments: [{ id: "recovered", fileName: file.name, kind: "file" }],
      });
      await harness.controller.retryAttachment(item.localId);
      expect(harness.uploadAttachments.mock.calls.at(-1)![0][0]).toBe(file);
      expect(harness.slice().attachments[0]).toMatchObject({
        localId: item.localId,
        status: "ready",
        uploadedId: "recovered",
      });
      expect(harness.prompt).not.toHaveBeenCalled();
    },
  );

  it("keeps a prior uncertain attachment fenced after a later definitive refusal", async () => {
    const harness = createHarness();
    harness.uploadAttachments.mockResolvedValue({
      attachments: [{ id: "uncertain", fileName: "kept.txt", kind: "file" }],
    });
    await harness.controller.addFiles([new File(["kept"], "kept.txt")]);
    harness.prompt.mockRejectedValue(new ApiTransportError("request", true));
    await harness.controller.send("possibly accepted");
    harness.prompt.mockRejectedValue(new ApiError(409, "Edited input refused"));
    await harness.controller.send("edited input");
    const next = "22222222-2222-4222-8222-222222222222";
    harness.replaceAuthority(next);
    harness.controller.reconcileAuthority(next);
    harness.controller.resumeUploads();
    expect(harness.uploadAttachments).toHaveBeenCalledOnce();
    expect(harness.prompt).toHaveBeenCalledTimes(2);
    expect(harness.slice().attachments[0]?.status).toBe("error");
  });

  it.each(["withdrawal", "transport replacement"] as const)(
    "reclaims late upload handles after %s",
    async (action) => {
      const harness = createHarness();
      const pending = deferred<{
        attachments: Array<{ id: string; fileName: string; kind: "file" }>;
      }>();
      harness.uploadAttachments.mockReturnValue(pending.promise);
      const names = ["one.txt", "two.txt"];
      const uploading = harness.controller.addFiles(
        names.map((name) => new File([name], name)),
      );
      const signal = harness.uploadAttachments.mock.calls[0]![1] as AbortSignal;
      if (action === "withdrawal") {
        const [first, second] = harness.slice().attachments;
        harness.controller.removeAttachment(first!.localId);
        expect(signal.aborted).toBe(false);
        harness.controller.removeAttachment(second!.localId);
      } else {
        harness.replaceTransport();
      }
      expect(signal.aborted).toBe(true);
      pending.resolve({
        attachments: names.map((name) => ({
          id: name,
          fileName: name,
          kind: "file",
        })),
      });
      await uploading;
      expect(harness.deleteAttachment.mock.calls).toEqual(
        names.map((name) => [name]),
      );
      expect(harness.slice().attachments.map(({ status }) => status)).toEqual(
        action === "withdrawal" ? [] : ["uploading", "uploading"],
      );
    },
  );
});
