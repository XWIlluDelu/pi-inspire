import { afterEach, expect, it, vi } from "vitest";
import type {
  PromptAcceptedResponse,
  UploadedAttachment,
} from "../../shared/contracts";
import { type Api, ApiError, ApiTransportError } from "../../src/api";
import { emptyTranscriptView } from "../../src/app-state";
import { ComposerController } from "../../src/controllers/composer-controller";
import { SessionDrafts } from "../../src/session-drafts";
import { deferred, TEST_HOST_AUTHORITY } from "./helpers";

const owner = "session-a";
const other = "session-b";
const nextAuthority = "22222222-2222-4222-8222-222222222222";
const ledger = `inspire:composer-operations:v1:${owner}`;
const accepted = {
  accepted: true,
  historyEntry: null,
} satisfies PromptAcceptedResponse;
const file = (name: string) => new File([name], name);

function uploaded(
  id: string,
  fileName = `${id}.txt`,
  kind: UploadedAttachment["kind"] = "file",
): UploadedAttachment {
  return {
    id,
    fileName,
    kind,
    mimeType: kind === "image" ? "image/png" : "text/plain",
    size: 4,
  };
}

function fixture() {
  let sessionId = owner;
  let authorityId = TEST_HOST_AUTHORITY;
  const view = { ...emptyTranscriptView, viewId: "view-a" };
  const drafts = new SessionDrafts();
  const transport = {
    prompt: vi.fn<Api["prompt"]>(),
    observePrompt: vi.fn<Api["observePrompt"]>(),
    uploadAttachments: vi.fn<Api["uploadAttachments"]>(),
    deleteAttachment: vi
      .fn<Api["deleteAttachment"]>()
      .mockResolvedValue({ ok: true }),
    attachmentPreview: vi
      .fn<Api["attachmentPreview"]>()
      .mockRejectedValue(new Error("Preview unavailable")),
  };
  let api = transport as unknown as Api;
  const notice = vi.fn();
  const authFailure = vi.fn();
  const controller = new ComposerController({
    state: () => ({ sessionId, view }),
    authorityId: () => authorityId,
    api: () => api,
    drafts,
    notify: (_kind, message) => notice(message),
    notifyVisible: (id, message) => {
      if (id === sessionId) notice(message);
    },
    handleAuthFailure: authFailure,
  });
  return {
    ...transport,
    controller,
    notice,
    authFailure,
    draft: (id = owner) => drafts.get(id),
    edit: (text: string) => drafts.setText(owner, text),
    select: (id: string) => {
      sessionId = id;
    },
    replaceTransport: (authority = authorityId) => {
      authorityId = authority;
      api = { ...api };
      controller.invalidateForTransportReplacement();
    },
    send: (text: string, behavior?: "steer" | "followUp") => {
      drafts.setText(sessionId, text);
      return (
        controller.retryIfTracking(sessionId) ??
        controller.send(text, behavior, drafts.get(sessionId))
      );
    },
    receipt: () => {
      const [request, , fingerprint] = transport.prompt.mock.calls[0]!;
      return {
        operationId: request.operationId,
        authorityId: request.authorityId,
        fingerprint,
      };
    },
    upload: (...attachments: UploadedAttachment[]) =>
      transport.uploadAttachments.mockResolvedValueOnce({ attachments }),
  };
}

afterEach(() => vi.useRealTimers());

it("deduplicates images per recovery handoff, including removed handles", () => {
  const f = fixture();
  const first = uploaded("first", "first.png", "image");
  const second = uploaded("second", "second.png", "image");
  const returnImages = (id: string, ...items: UploadedAttachment[]) =>
    f.controller.restoreStagedAttachments(
      owner,
      items,
      TEST_HOST_AUTHORITY,
      id,
    );
  const handles = () => f.draft().attachments.map((item) => item.uploadedId);
  returnImages("handoff", first);
  f.controller.removeAttachment(f.draft().attachments[0]!.localId);
  returnImages("handoff", first, second);
  expect(handles()).toEqual(["second"]);
  returnImages("next handoff", first);
  expect(handles()).toEqual(["first", "second"]);
});

it.each(["refused", "unknown"] as const)(
  "restores %s input only on explicit request after a draft edit back to empty",
  async (outcome) => {
    const f = fixture();
    const reply = deferred<PromptAcceptedResponse>();
    f.prompt.mockReturnValueOnce(reply.promise).mockResolvedValue(accepted);
    f.observePrompt.mockResolvedValue(accepted);
    f.controller.addProjectFile("original.ts");
    const sending = f.send("original", "steer");
    f.edit("later");
    f.edit("");
    reply.reject(
      outcome === "refused"
        ? new ApiError(409, "not delivered")
        : new ApiTransportError("request", true),
    );
    expect(await sending).toBe(false);
    expect(f.draft()).toMatchObject({ text: "", projectFiles: [] });
    expect(f.controller.deliveryState(owner).failedCount).toBe(1);
    expect(f.controller.restoreFailedPrompt(owner)).toBe(true);
    expect(f.draft()).toMatchObject({
      text: "original",
      projectFiles: ["original.ts"],
    });
    expect(await f.send("original")).toEqual(accepted);
    if (outcome === "unknown") {
      expect(f.observePrompt).toHaveBeenCalledExactlyOnceWith(
        f.receipt(),
        expect.any(AbortSignal),
      );
      expect(f.prompt).toHaveBeenCalledOnce();
    } else {
      expect(f.observePrompt).not.toHaveBeenCalled();
      expect(f.prompt.mock.calls[1]?.[0].operationId).not.toBe(
        f.receipt().operationId,
      );
    }
  },
);

it.each(["accepted", "PROMPT_RECOVERED", "PROMPT_CLEARED"] as const)(
  "keeps newer staging in the original session after %s",
  async (outcome) => {
    const f = fixture();
    const reply = deferred<PromptAcceptedResponse>();
    f.prompt.mockReturnValue(reply.promise);
    f.upload(uploaded("sent", "sent.png", "image"));
    f.upload(uploaded("next"));
    await f.controller.addFiles([
      new File(["data"], "sent.png", { type: "image/png" }),
    ]);
    f.controller.addProjectFile("sent.ts");
    const sending = f.send("pending input", "steer");
    f.controller.addProjectFile("next.ts");
    await f.controller.addFiles([file("next.txt")]);
    f.select(other);
    if (outcome === "accepted") reply.resolve(accepted);
    else
      reply.reject(
        new ApiError(409, "Pending input changed", undefined, outcome),
      );
    const returned = outcome === "PROMPT_RECOVERED";
    expect(await sending).toEqual(outcome === "accepted" ? accepted : false);
    expect(f.draft()).toMatchObject({
      text: "",
      projectFiles: returned ? ["sent.ts", "next.ts"] : ["next.ts"],
    });
    expect(f.draft().attachments.map((item) => item.uploadedId)).toEqual(
      returned ? ["sent", "next"] : ["next"],
    );
    expect(f.draft(other)).toMatchObject({
      text: "",
      projectFiles: [],
      attachments: [],
    });
    expect(f.controller.deliveryState(owner).failedCount).toBe(0);
    expect(f.deleteAttachment.mock.calls).toEqual(
      outcome === "PROMPT_CLEARED" ? [["sent"]] : [],
    );
  },
);

it.each(["background transport", "current authorization"] as const)(
  "keeps draft ownership without a stray notice after %s fails",
  async (failure) => {
    const f = fixture();
    const unauthorized = failure === "current authorization";
    f.prompt.mockRejectedValue(
      unauthorized
        ? new ApiError(401, "expired token")
        : new ApiTransportError("request"),
    );
    f.controller.addProjectFile("message.ts");
    const sending = f.send("send");
    if (!unauthorized) f.select(other);
    expect(await sending).toBe(false);
    expect(f.draft()).toMatchObject({
      text: "send",
      projectFiles: ["message.ts"],
    });
    expect(f.authFailure).toHaveBeenCalledTimes(unauthorized ? 1 : 0);
    expect(f.notice).not.toHaveBeenCalled();
  },
);

it("resumes the same observation after a replaced transport and never clears intervening edits", async () => {
  const f = fixture();
  const submission = deferred<PromptAcceptedResponse>();
  const read = deferred<PromptAcceptedResponse>();
  f.prompt.mockReturnValue(submission.promise);
  f.observePrompt.mockReturnValueOnce(read.promise).mockResolvedValue(accepted);
  f.controller.addProjectFile("plan.md");
  const sending = f.send("original");
  f.replaceTransport();
  expect(f.prompt.mock.calls[0]![1]?.aborted).toBe(true);
  expect(f.draft()).toMatchObject({
    text: "original",
    intentId: f.receipt().operationId,
    projectFiles: ["plan.md"],
  });
  f.edit("");
  f.controller.removeProjectFile("plan.md");
  f.controller.addProjectFile("plan.md");
  const observing = f.controller.retryIfTracking(owner);
  submission.resolve(accepted);
  expect(await sending).toBe(false);
  const [identity, signal] = f.observePrompt.mock.calls[0]!;
  expect(signal?.aborted).toBe(false);
  f.replaceTransport();
  expect(signal?.aborted).toBe(true);
  read.resolve(accepted);
  expect(await observing).toBe(false);
  expect(await f.controller.retryIfTracking(owner)).toEqual(accepted);
  expect(f.observePrompt.mock.calls.map(([receipt]) => receipt)).toEqual([
    f.receipt(),
    identity,
  ]);
  expect(f.prompt).toHaveBeenCalledOnce();
  expect(f.draft()).toMatchObject({
    text: "",
    intentId: undefined,
    projectFiles: ["plan.md"],
  });
});

it("reloads an unresolved receipt without replaying its prompt or clearing its saved text", async () => {
  const original = fixture();
  original.prompt.mockRejectedValue(new ApiTransportError("request"));
  await original.send("unconfirmed", "followUp");
  expect(JSON.parse(sessionStorage.getItem(ledger)!)).toEqual([
    original.receipt(),
  ]);

  const reopened = fixture();
  reopened.controller.loadDeliveries(owner);
  expect(reopened.draft().text).toBe("unconfirmed");
  expect(await reopened.controller.send("another request")).toBe(false);
  reopened.observePrompt.mockResolvedValue(accepted);
  expect(await reopened.send("unconfirmed")).toEqual(accepted);
  expect(reopened.observePrompt).toHaveBeenCalledExactlyOnceWith(
    original.receipt(),
    expect.any(AbortSignal),
  );
  expect(reopened.prompt).not.toHaveBeenCalled();
  expect(reopened.draft().text).toBe("unconfirmed");
  expect(sessionStorage.getItem(ledger)).toBeNull();
});

it.each([false, true])(
  "stages fresh bytes only after explicitly leaving an unconfirmed identical send (Host restarted: %s)",
  async (restarted) => {
    const f = fixture();
    const originalFile = file("kept.txt");
    f.upload(uploaded("original", originalFile.name));
    f.upload(uploaded("restaged", originalFile.name));
    await f.controller.addFiles([originalFile]);
    f.replaceTransport();
    f.controller.reconcileAuthority(TEST_HOST_AUTHORITY);
    f.controller.resumeUploads();
    expect(f.uploadAttachments).toHaveBeenCalledOnce();
    f.prompt
      .mockRejectedValueOnce(new ApiTransportError("request", true))
      .mockResolvedValue(accepted);
    await f.send("same caption");
    if (restarted) {
      f.replaceTransport(nextAuthority);
      expect(await f.send("same caption")).toBe(false);
      expect(f.notice).toHaveBeenLastCalledWith(
        expect.stringContaining("Check the conversation"),
      );
      expect(f.observePrompt).not.toHaveBeenCalled();
    }
    expect(f.prompt).toHaveBeenCalledOnce();
    f.controller.detach(owner);
    await vi.waitFor(() =>
      expect(f.draft().attachments[0]?.status).toBe("ready"),
    );
    expect(f.deleteAttachment).not.toHaveBeenCalled();
    expect(f.uploadAttachments.mock.calls[1]![0]).toEqual([originalFile]);
    expect(await f.send("same caption")).toEqual(accepted);
    const next = f.prompt.mock.calls[1]![0];
    expect(next).toMatchObject({
      authorityId: restarted ? nextAuthority : TEST_HOST_AUTHORITY,
      attachmentIds: ["restaged"],
    });
    expect(next.operationId).not.toBe(f.receipt().operationId);
    expect(f.controller.deliveryState(owner).previous).toBe(
      f.receipt().operationId,
    );
  },
);

it("preserves existing receipt records when tab storage refuses a new operation", async () => {
  const f = fixture();
  f.prompt.mockRejectedValueOnce(new ApiTransportError("request"));
  await f.send("original");
  f.controller.detach(owner);
  const saved = sessionStorage.getItem(ledger);
  expect(saved).toContain(f.receipt().operationId);
  const storage = window.sessionStorage;
  const writes = vi.spyOn(window, "sessionStorage", "get").mockReturnValue({
    getItem: storage.getItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
    setItem(key: string, value: string) {
      if (key === ledger) throw new DOMException("quota", "QuotaExceededError");
      storage.setItem(key, value);
    },
  } as Storage);
  try {
    expect(await f.send("new draft")).toBe(false);
    expect(f.prompt).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(ledger)).toBe(saved);
    expect(f.draft().text).toBe("new draft");
    expect(f.controller.deliveryState(owner).storageIssue).toBe("storage");
  } finally {
    writes.mockRestore();
  }
});

it("keeps unreadable receipt records until the editor explicitly stops tracking them", async () => {
  const f = fixture();
  const old = '[{"old":true}]';
  sessionStorage.setItem(ledger, old);
  expect(await f.send("new draft")).toBe(false);
  expect(f.prompt).not.toHaveBeenCalled();
  expect(f.controller.deliveryState(owner).storageIssue).toBe("format");
  expect(sessionStorage.getItem(ledger)).toBe(old);
  f.controller.forgetUnsupportedDeliveries(owner);
  expect(sessionStorage.getItem(ledger)).toBeNull();
  f.prompt.mockResolvedValue(accepted);
  expect(await f.send("new draft")).toEqual(accepted);
});

it("retains a recalled image after a refused send while releasing the displaced upload", async () => {
  const f = fixture();
  f.upload(uploaded("displaced"));
  await f.controller.addFiles([file("displaced.txt")]);
  const reference = "pi-history-image://entry-4/1";
  expect(
    f.controller.useHistoryEntry(
      {
        sessionId: owner,
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
    ),
  ).toBe(true);
  f.prompt.mockRejectedValue(new ApiError(409, "not delivered"));
  expect(await f.send("recalled")).toBe(false);
  expect(f.deleteAttachment).toHaveBeenCalledExactlyOnceWith("displaced");
  expect(f.draft().attachments).toMatchObject([
    { recalledArtifact: { type: "image", reference } },
  ]);
});

it("restages browser-held bytes from a failed delivery in its inactive partition after Host replacement", async () => {
  const f = fixture();
  const draftFile = file("draft.txt");
  f.upload(uploaded("old-upload", draftFile.name));
  f.upload(uploaded("new-upload", draftFile.name));
  await f.controller.addFiles([draftFile]);
  f.prompt
    .mockRejectedValueOnce(new ApiError(409, "not sent"))
    .mockResolvedValue(accepted);
  const sending = f.send("send");
  f.edit("newer");
  f.edit("");
  expect(await sending).toBe(false);
  f.select(other);
  f.replaceTransport(nextAuthority);
  f.controller.reconcileAuthority(nextAuthority);
  expect(f.controller.restoreFailedPrompt(owner)).toBe(true);
  await vi.waitFor(() =>
    expect(f.draft().attachments[0]).toMatchObject({
      status: "ready",
      uploadedId: "new-upload",
      uploadedAuthorityId: nextAuthority,
    }),
  );
  expect(f.uploadAttachments.mock.calls[1]![0]).toEqual([draftFile]);
  expect(f.draft(other).attachments).toEqual([]);
  f.select(owner);
  expect(await f.send("send")).toEqual(accepted);
  expect(f.prompt.mock.calls[1]![0]).toMatchObject({
    authorityId: nextAuthority,
    attachmentIds: ["new-upload"],
  });
});

it("restages only definitively expired handles and waits for another deliberate send", async () => {
  const f = fixture();
  const expired = file("expired.txt");
  f.upload(uploaded("expired"), uploaded("valid"));
  await f.controller.addFiles([expired, file("valid.txt")]);
  const replacement = deferred<{ attachments: UploadedAttachment[] }>();
  f.uploadAttachments.mockReturnValueOnce(replacement.promise);
  f.prompt
    .mockRejectedValueOnce(
      new ApiError(
        409,
        "Attachments expired",
        ["expired"],
        "ATTACHMENTS_EXPIRED",
      ),
    )
    .mockResolvedValue(accepted);
  expect(await f.send("send")).toBe(false);
  expect(f.draft().attachments.map(({ status }) => status)).toEqual([
    "uploading",
    "ready",
  ]);
  expect(f.uploadAttachments.mock.calls[1]![0]).toEqual([expired]);
  expect(await f.send("send")).toBe(false);
  replacement.resolve({ attachments: [uploaded("renewed", expired.name)] });
  await vi.waitFor(() =>
    expect(f.draft().attachments[0]?.status).toBe("ready"),
  );
  expect(f.prompt).toHaveBeenCalledOnce();
  expect(await f.send("send")).toEqual(accepted);
  expect(f.prompt.mock.calls[1]![0].attachmentIds).toEqual([
    "renewed",
    "valid",
  ]);
});

it.each(["refused", "incomplete"] as const)(
  "blocks sending a %s upload batch and reclaims any partial handles",
  async (outcome) => {
    const f = fixture();
    if (outcome === "incomplete") f.upload(uploaded("partial", "one.txt"));
    else
      f.uploadAttachments.mockRejectedValue(
        new ApiError(400, "Unsupported file"),
      );
    await f.controller.addFiles([file("one.txt"), file("two.txt")]);
    expect(f.deleteAttachment.mock.calls).toEqual(
      outcome === "incomplete" ? [["partial"]] : [],
    );
    expect(f.draft().attachments.map(({ status }) => status)).toEqual([
      "error",
      "error",
    ]);
    expect(await f.send("send")).toBe(false);
    expect(f.notice).toHaveBeenLastCalledWith(
      "Retry or remove failed attachments before sending",
    );
    expect(f.prompt).not.toHaveBeenCalled();
  },
);

it.each(["withdrawal", "retry"] as const)(
  "holds the draft during a transient upload failure until %s",
  async (action) => {
    vi.useFakeTimers();
    const f = fixture();
    const originalFile = file("retained.txt");
    f.uploadAttachments.mockRejectedValue(
      new ApiTransportError("request", true, true),
    );
    await f.controller.addFiles([originalFile]);
    const item = f.draft().attachments[0]!;
    expect(item.status).toBe("uploading");
    expect(await f.send("message")).toBe(false);
    if (action === "withdrawal") f.controller.removeAttachment(item.localId);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(f.uploadAttachments).toHaveBeenCalledTimes(
      action === "withdrawal" ? 1 : 4,
    );
    expect(f.prompt).not.toHaveBeenCalled();
    if (action === "retry") {
      expect(f.draft().attachments[0]).toMatchObject({
        status: "error",
        retryable: true,
      });
      f.upload(uploaded("recovered", originalFile.name));
      await f.controller.retryAttachment(item.localId);
      expect(f.uploadAttachments.mock.calls.at(-1)![0]).toEqual([originalFile]);
      expect(f.draft().attachments[0]).toMatchObject({
        localId: item.localId,
        status: "ready",
        uploadedId: "recovered",
      });
    }
    f.prompt.mockResolvedValue(accepted);
    expect(await f.send("message")).toEqual(accepted);
  },
);

it.each(["withdrawal", "transport replacement"] as const)(
  "retires the whole upload only when no current owner remains after %s",
  async (action) => {
    const f = fixture();
    const reply = deferred<{ attachments: UploadedAttachment[] }>();
    f.uploadAttachments.mockReturnValue(reply.promise);
    const staging = f.controller.addFiles([file("one.txt"), file("two.txt")]);
    const signal = f.uploadAttachments.mock.calls[0]![1]!;
    if (action === "withdrawal") {
      const [first, second] = f.draft().attachments;
      f.controller.removeAttachment(first!.localId);
      expect(signal.aborted).toBe(false);
      f.controller.removeAttachment(second!.localId);
    } else f.replaceTransport();
    expect(signal.aborted).toBe(true);
    reply.resolve({ attachments: [uploaded("one"), uploaded("two")] });
    await staging;
    expect(f.deleteAttachment.mock.calls).toEqual([["one"], ["two"]]);
    expect(f.draft().attachments.map(({ status }) => status)).toEqual(
      action === "withdrawal" ? [] : ["uploading", "uploading"],
    );
  },
);
