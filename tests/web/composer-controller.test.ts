import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptAcceptedResponse } from "../../shared/contracts";
import { type Api, ApiError, ApiTransportError } from "../../src/api";
import { ComposerController } from "../../src/controllers/composer-controller";
import { SessionDrafts } from "../../src/session-drafts";
import { deferred } from "./helpers";

function createHarness(
  sessionId = "session-a",
  transcriptViewId: string | null = null,
  drafts = new SessionDrafts(),
) {
  let activeSessionId: string | null = sessionId;
  const prompt = vi.fn();
  const observePrompt = vi.fn();
  const uploadAttachments = vi.fn();
  const deleteAttachment = vi.fn().mockResolvedValue(undefined);
  let authorityId = "11111111-1111-4111-8111-111111111111";
  let api = {
    prompt,
    observePrompt,
    uploadAttachments,
    deleteAttachment,
    attachmentPreview: vi
      .fn()
      .mockRejectedValue(new Error("Preview unavailable")),
  } as unknown as Api;
  const notify = vi.fn();
  const notifyVisible = vi.fn();
  const handleAuthFailure = vi.fn();
  const controller = new ComposerController({
    state: () => ({ sessionId: activeSessionId, transcriptViewId }),
    api: () => api,
    authorityId: () => authorityId,
    drafts,
    notify,
    handleAuthFailure,
    notifyVisible: (owner, message) => {
      if (activeSessionId === owner) notifyVisible(message);
    },
  });
  return {
    controller,
    drafts,
    prompt,
    observePrompt,
    uploadAttachments,
    notify,
    notifyVisible,
    handleAuthFailure,
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
    send: (message: string, behavior?: "steer" | "followUp") => {
      drafts.setText(activeSessionId, message);
      return (
        (activeSessionId && controller.retryIfTracking(activeSessionId)) ||
        controller.send(message, behavior, drafts.get(activeSessionId))
      );
    },
    slice: (id = sessionId) => {
      const { attachments, projectFiles } = drafts.get(id);
      return {
        attachments,
        projectFiles,
        failedDeliveryCount: controller.deliveryState(id).failedCount,
      };
    },
  };
}

const acceptedPrompt: PromptAcceptedResponse = {
  accepted: true,
  historyEntry: null,
};
const receiptKey = "inspire:composer-operations:v1:session-a";

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
    "restores the %s input without replacing the later draft",
    async (outcome) => {
      const f = createHarness();
      const receipt = deferred<PromptAcceptedResponse>();
      f.prompt
        .mockReturnValueOnce(receipt.promise)
        .mockResolvedValue(acceptedPrompt);
      f.observePrompt.mockResolvedValue(acceptedPrompt);
      f.controller.addProjectFile("/workspace/original.ts");
      const sending = f.send("original", "steer");
      const [original] = f.prompt.mock.calls[0]!;
      expect(f.drafts.get("session-a")).toMatchObject({
        text: "",
        projectFiles: [],
      });
      f.drafts.setText("session-a", "later");
      f.drafts.setText("session-a", "");
      receipt.reject(
        outcome === "unknown"
          ? new ApiTransportError("request", true)
          : new ApiError(409, "not delivered"),
      );
      await expect(sending).resolves.toBe(false);
      expect(f.drafts.get("session-a").text).toBe("");
      expect(f.slice().failedDeliveryCount).toBe(1);
      expect(f.controller.restoreFailedPrompt("session-a")).toBe(true);
      expect(f.drafts.get("session-a")).toMatchObject({
        text: "original",
        projectFiles: ["/workspace/original.ts"],
      });
      await f.send("original");
      if (outcome === "unknown") {
        expect(f.observePrompt).toHaveBeenCalledExactlyOnceWith(
          {
            operationId: original.operationId,
            authorityId: original.authorityId,
            fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
          expect.any(AbortSignal),
        );
        expect(f.prompt).toHaveBeenCalledOnce();
      } else {
        const [next] = f.prompt.mock.calls[1]!;
        expect(next.operationId).not.toBe(original.operationId);
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
      const sending = f.send("pending input", "steer");
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
      expect(f.drafts.get("session-a").text).toBe("");
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

    const sending = harness.send("inspect this");
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
      expect.stringMatching(/^[a-f0-9]{64}$/u),
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

      const sending = f.send("send");
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
    harness.prompt.mockReturnValueOnce(pending.promise);
    harness.observePrompt
      .mockReturnValueOnce(retry.promise)
      .mockResolvedValueOnce(acceptedPrompt);
    harness.controller.addProjectFile("/workspace/kept.ts");
    const sending = harness.send("synthetic prompt");
    const [first, signal] = harness.prompt.mock.calls[0]!;
    harness.replaceTransport();
    expect(signal.aborted).toBe(true);
    expect(harness.slice().projectFiles).toEqual(["/workspace/kept.ts"]);
    const retrying = harness.send("synthetic prompt");
    const [identity, retrySignal] = harness.observePrompt.mock.calls[0]!;
    expect(identity).toEqual({
      operationId: first.operationId,
      authorityId: first.authorityId,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    pending.resolve(acceptedPrompt);
    await expect(sending).resolves.toBe(false);
    expect(retrySignal.aborted).toBe(false);
    harness.replaceTransport();
    expect(retrySignal.aborted).toBe(true);
    retry.resolve(acceptedPrompt);
    await expect(retrying).resolves.toBe(false);
    await expect(harness.send("synthetic prompt")).resolves.toEqual(
      acceptedPrompt,
    );
    expect(harness.observePrompt.mock.calls[1]![0]).toEqual(identity);
    expect(harness.prompt).toHaveBeenCalledOnce();
  });

  it("checks only the original receipt after editing and leaves the new input intact", async () => {
    const f = createHarness();
    f.prompt.mockRejectedValueOnce(new ApiTransportError("request"));
    f.observePrompt.mockResolvedValue(acceptedPrompt);
    f.controller.addProjectFile("plan.md");
    await f.send("original");
    f.drafts.setText("session-a", "");
    f.controller.removeProjectFile("plan.md");
    f.controller.addProjectFile("plan.md");
    await f.controller.retryIfTracking("session-a");
    const [original] = f.prompt.mock.calls[0]!;
    expect(f.observePrompt).toHaveBeenCalledExactlyOnceWith(
      {
        operationId: original.operationId,
        authorityId: original.authorityId,
        fingerprint: f.prompt.mock.calls[0]![2],
      },
      expect.any(AbortSignal),
    );
    expect(f.drafts.get("session-a")).toMatchObject({
      text: "",
      projectFiles: ["plan.md"],
      intentId: undefined,
    });
  });

  it("requires explicit new input before sending the same text after a Host restart", async () => {
    const f = createHarness();
    f.prompt
      .mockRejectedValueOnce(new ApiTransportError("request"))
      .mockResolvedValue(acceptedPrompt);
    await f.send("inspect first");
    const [original] = f.prompt.mock.calls[0]!;
    f.replaceAuthority("22222222-2222-4222-8222-222222222222");

    await expect(f.send("inspect first")).resolves.toBe(false);
    expect(f.prompt).toHaveBeenCalledTimes(1);
    expect(f.notifyVisible).toHaveBeenLastCalledWith(
      expect.stringContaining("Check the conversation"),
    );
    f.controller.detach("session-a");
    expect(f.controller.deliveryState("session-a").previous).toBe(
      original.operationId,
    );
    await expect(f.send("inspect first")).resolves.toEqual(acceptedPrompt);
    const [next] = f.prompt.mock.calls[1]!;
    expect(next.operationId).not.toBe(original.operationId);
    expect(next.authorityId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("restores an unknown prompt after reload and reads only its original receipt", async () => {
    const first = createHarness();
    first.prompt.mockRejectedValue(new ApiTransportError("request"));
    await first.send("Recover this exact input", "followUp");
    const [original] = first.prompt.mock.calls[0]!;
    const saved = JSON.parse(window.sessionStorage.getItem(receiptKey)!);
    const fingerprint = first.prompt.mock.calls[0]![2];
    expect(saved).toEqual([
      {
        authorityId: original.authorityId,
        operationId: original.operationId,
        fingerprint,
      },
    ]);
    const next = createHarness();
    const receipt = deferred<PromptAcceptedResponse>();
    next.observePrompt.mockReturnValue(receipt.promise);
    next.controller.loadDeliveries("session-a");
    expect(next.drafts.get("session-a").text).toBe("Recover this exact input");
    const checking = next.send("Recover this exact input");
    await expect(next.controller.send("another request")).resolves.toBe(false);
    receipt.resolve(acceptedPrompt);
    await expect(checking).resolves.toEqual(acceptedPrompt);
    expect(next.observePrompt).toHaveBeenCalledExactlyOnceWith(
      {
        operationId: original.operationId,
        authorityId: original.authorityId,
        fingerprint,
      },
      expect.any(AbortSignal),
    );
    expect(next.prompt).not.toHaveBeenCalled();
    expect(next.drafts.get("session-a").text).toBe("Recover this exact input");
  });

  it("keeps existing receipt records when publishing another prompt fails", async () => {
    const f = createHarness();
    f.prompt.mockRejectedValueOnce(new ApiTransportError("request"));
    await f.send("original");
    f.controller.detach("session-a");
    const saved = window.sessionStorage.getItem(receiptKey);
    expect(saved).toContain(f.prompt.mock.calls[0]![0].operationId);
    const storage = window.sessionStorage;
    const writes = vi.spyOn(window, "sessionStorage", "get").mockReturnValue({
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem(item: string, value: string) {
        if (item === receiptKey)
          throw new DOMException("quota", "QuotaExceededError");
        storage.setItem(item, value);
      },
    } as Storage);
    try {
      await expect(f.send("new draft")).resolves.toBe(false);
      expect(f.prompt).toHaveBeenCalledOnce();
      expect(window.sessionStorage.getItem(receiptKey)).toBe(saved);
      expect(f.drafts.get("session-a").text).toBe("new draft");
      expect(f.controller.deliveryState("session-a").storageIssue).toBe(
        "storage",
      );
    } finally {
      writes.mockRestore();
    }
  });

  it("retains an unreadable receipt until the user explicitly stops tracking it", async () => {
    const f = createHarness();
    window.sessionStorage.setItem(receiptKey, JSON.stringify([{ old: true }]));
    await expect(f.send("new draft")).resolves.toBe(false);
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.observePrompt).not.toHaveBeenCalled();
    expect(f.controller.deliveryState("session-a").storageIssue).toBe("format");
    expect(window.sessionStorage.getItem(receiptKey)).toContain("old");
    f.controller.forgetUnsupportedDeliveries("session-a");
    expect(window.sessionStorage.getItem(receiptKey)).toBeNull();
    f.prompt.mockResolvedValue(acceptedPrompt);
    await expect(f.send("new draft")).resolves.toEqual(acceptedPrompt);
  });

  it("retains recalled artifacts after a refused send and releases the displaced draft", async () => {
    const f = createHarness("session-a", "view-a");
    f.uploadAttachments.mockResolvedValue({
      attachments: [{ id: "draft-file", fileName: "draft.txt", kind: "file" }],
    });
    await f.controller.addFiles([new File(["draft"], "draft.txt")]);
    const reference = "pi-history-image://entry-4/1";
    f.controller.useHistoryEntry(
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
    await expect(f.send("recalled")).resolves.toBe(false);
    expect(f.deleteAttachment).toHaveBeenCalledWith("draft-file");
    expect(f.slice().attachments).toMatchObject([
      { recalledArtifact: { type: "image", reference } },
    ]);
  });

  it.each(["staged", "failed delivery"])(
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
      if (location === "failed delivery") {
        harness.prompt.mockRejectedValue(new ApiError(409, "not sent"));
        const sending = harness.send("send");
        harness.drafts.setText("session-a", "newer");
        harness.drafts.setText("session-a", "");
        await sending;
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
      await expect(harness.send("send")).resolves.toEqual(acceptedPrompt);
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
    await expect(harness.send("send")).resolves.toBe(false);
    expect(harness.slice().attachments.map((item) => item.status)).toEqual([
      "uploading",
      "ready",
    ]);
    expect(harness.uploadAttachments).toHaveBeenCalledTimes(2);
    expect(harness.uploadAttachments.mock.calls[1]![0]).toEqual([
      harness.uploadAttachments.mock.calls[0]![0][0],
    ]);
    await expect(harness.send("send")).resolves.toBe(false);
    expect(harness.prompt).toHaveBeenCalledOnce();
    replacement.resolve({
      attachments: [{ id: "renewed", fileName: "expired.txt", kind: "file" }],
    });
    await vi.waitFor(() =>
      expect(harness.slice().attachments[0]?.status).toBe("ready"),
    );
    expect(harness.prompt).toHaveBeenCalledOnce();
    harness.prompt.mockResolvedValue(acceptedPrompt);
    await harness.send("send");
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
      await expect(harness.send("send")).resolves.toBe(false);
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
      await expect(harness.send("message")).resolves.toBe(false);

      if (action === "withdrawal") {
        harness.controller.removeAttachment(item.localId);
        await vi.advanceTimersByTimeAsync(14_000);
        expect(harness.uploadAttachments).toHaveBeenCalledOnce();
        expect(harness.prompt).not.toHaveBeenCalled();
        harness.prompt.mockResolvedValue(acceptedPrompt);
        await expect(harness.send("message")).resolves.toEqual(acceptedPrompt);
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

  it("stages a new handle for an identical file after explicitly leaving uncertain delivery", async () => {
    const f = createHarness();
    const file = new File(["kept"], "kept.txt");
    f.uploadAttachments
      .mockResolvedValueOnce({
        attachments: [{ id: "original", fileName: file.name, kind: "file" }],
      })
      .mockResolvedValueOnce({
        attachments: [{ id: "restaged", fileName: file.name, kind: "file" }],
      });
    await f.controller.addFiles([file]);
    f.prompt
      .mockRejectedValueOnce(new ApiTransportError("request", true))
      .mockResolvedValue(acceptedPrompt);
    await f.send("same caption");
    f.controller.detach("session-a");
    await vi.waitFor(() =>
      expect(f.drafts.get("session-a").attachments[0]?.status).toBe("ready"),
    );
    expect(f.deleteAttachment).not.toHaveBeenCalled();
    expect(f.uploadAttachments.mock.calls[1]![0]).toEqual([file]);
    await f.send("same caption");
    const [first, second] = f.prompt.mock.calls.map(([request]) => request);
    expect(second.operationId).not.toBe(first.operationId);
    expect(second.attachmentIds).toEqual(["restaged"]);
    expect(f.controller.deliveryState("session-a").previous).toBe(
      first.operationId,
    );
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
