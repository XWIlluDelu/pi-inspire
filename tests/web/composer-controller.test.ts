import { MAX_ATTACHMENTS } from "../../shared/contracts";
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
} satisfies PromptAcceptedResponse;
const file = (name: string) => new File([name], name);

function uploaded(id: string, fileName = `${id}.txt`): UploadedAttachment {
  const image = fileName.endsWith(".png");
  return {
    id,
    fileName,
    kind: image ? "image" : "file",
    mimeType: image ? "image/png" : "text/plain",
    size: 4,
  };
}
const image = (id: string) => uploaded(id, `${id}.png`);

function fixture() {
  let sessionId = owner;
  let authorityId = TEST_HOST_AUTHORITY;
  const view = emptyTranscriptView;
  const drafts = new SessionDrafts();
  const transport = {
    prompt: vi.fn<Api["prompt"]>(),
    observePrompt: vi.fn<Api["observePrompt"]>(),
    uploadAttachments: vi.fn<Api["uploadAttachments"]>(),
    deleteAttachment: vi
      .fn<Api["deleteAttachment"]>()
      .mockResolvedValue({ ok: true }),
    attachmentPreview: async () => {
      throw new Error("Preview unavailable");
    },
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
    handles: () =>
      drafts.get(owner).attachments.map(({ uploadedId }) => uploadedId),
    stage: (
      attachment: UploadedAttachment,
      source = file(attachment.fileName),
    ) => {
      transport.uploadAttachments.mockResolvedValueOnce({
        attachments: [attachment],
      });
      return controller.addFiles([source]);
    },
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
      return controller.send(text, behavior, drafts.get(sessionId));
    },
    receipt: (index = 0) => {
      const [request, , fingerprint] = transport.prompt.mock.calls[index]!;
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

it("applies repeated recovery only to new image handles and fences over-limit sends", async () => {
  const f = fixture();
  const apply = (recovery: string, ...ids: string[]) =>
    f.controller.restoreStagedAttachments(
      owner,
      ids.map(image),
      TEST_HOST_AUTHORITY,
      recovery,
    );
  apply("first", "first");
  f.controller.removeAttachment(f.draft().attachments[0]!.localId);
  apply("first", "first", "second");
  expect(f.handles()).toEqual(["second"]);
  apply("next", "first");
  expect(f.handles()).toEqual(["first", "second"]);
  apply(
    "overflow",
    ...Array.from({ length: MAX_ATTACHMENTS }, (_, index) => `more-${index}`),
  );
  await expect(f.send("Recover these attachments")).resolves.toBe(false);
  expect(f.prompt).not.toHaveBeenCalled();
});

it.each([true, false])(
  "leaves newer input intact when Pi returns or clears old input (returned: %s)",
  async (returned) => {
    const f = fixture();
    const reply = deferred<PromptAcceptedResponse>();
    f.prompt.mockReturnValue(reply.promise);
    await f.stage(
      image("sent"),
      new File(["data"], "sent.png", { type: "image/png" }),
    );
    f.controller.addProjectFile("sent.ts");
    const sending = f.send("pending", "steer");
    f.controller.addProjectFile("next.ts");
    await f.stage(uploaded("next"));
    f.select(other);

    reply.reject(
      new ApiError(
        409,
        "Pending input changed",
        undefined,
        returned ? "PROMPT_RECOVERED" : "PROMPT_CLEARED",
      ),
    );
    expect(await sending).toBe(false);
    expect(f.draft().projectFiles).toEqual(
      returned ? ["sent.ts", "next.ts"] : ["next.ts"],
    );
    expect(f.handles()).toEqual(returned ? ["sent", "next"] : ["next"]);
    expect(f.draft(other).attachments).toEqual([]);
    expect(f.controller.deliveryState(owner).failedCount).toBe(0);
    expect(f.deleteAttachment.mock.calls).toEqual(returned ? [] : [["sent"]]);
  },
);

it("ignores a retired result and observes the original operation on the new transport", async () => {
  const f = fixture();
  await f.stage(uploaded("ready"));
  f.replaceTransport();
  f.controller.reconcileAuthority(TEST_HOST_AUTHORITY);
  f.controller.resumeUploads();
  expect(f.handles()).toEqual(["ready"]);
  expect(f.uploadAttachments).toHaveBeenCalledOnce();
  const submission = deferred<PromptAcceptedResponse>();
  f.prompt.mockReturnValue(submission.promise);
  f.observePrompt.mockResolvedValue(accepted);
  const sending = f.send("original");
  const [, signal] = f.prompt.mock.calls[0]!;
  f.replaceTransport();
  expect(signal?.aborted).toBe(true);
  expect(f.draft().text).toBe("");
  expect(f.draft().intentId).toBeUndefined();
  expect(f.controller.deliveryState(owner).previous).toBe(
    f.receipt().operationId,
  );

  f.edit("replacement");
  submission.resolve(accepted);
  expect(await sending).toBe(false);
  await f.controller.retryPrevious(owner);
  expect(f.observePrompt).toHaveBeenCalledExactlyOnceWith(
    f.receipt(),
    expect.any(AbortSignal),
  );
  expect(f.prompt).toHaveBeenCalledOnce();
  expect(f.draft().text).toBe("replacement");
  expect(f.draft().intentId).toBeUndefined();
});

it("reloads a current receipt for observation and blocks writes when tab storage cannot track them", async () => {
  const original = fixture();
  const unknown = new ApiTransportError("response", true);
  original.prompt.mockRejectedValue(unknown);
  original.observePrompt.mockRejectedValue(unknown);
  expect(await original.send("unconfirmed", "followUp")).toBe(false);
  const saved = sessionStorage.getItem(ledger);
  expect(JSON.parse(saved!)).toEqual([original.receipt()]);

  const storage = sessionStorage;
  const writes = vi.spyOn(window, "sessionStorage", "get").mockReturnValue({
    getItem: storage.getItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
    setItem(key: string, value: string) {
      if (key === ledger) throw new DOMException("quota", "QuotaExceededError");
      storage.setItem(key, value);
    },
  } as Storage);
  try {
    expect(await original.send("new draft")).toBe(false);
    expect(original.controller.deliveryState(owner).storageIssue).toBe(
      "storage",
    );
    expect(sessionStorage.getItem(ledger)).toBe(saved);
  } finally {
    writes.mockRestore();
  }

  expect(original.prompt).toHaveBeenCalledOnce();
  const reopened = fixture();
  const confirmation = deferred<PromptAcceptedResponse>();
  reopened.observePrompt.mockReturnValue(confirmation.promise);
  reopened.prompt.mockResolvedValue(accepted);
  // A read denial must not overwrite an identity when storage is writable.
  const reads = vi.spyOn(window, "sessionStorage", "get").mockReturnValue({
    getItem() {
      throw new DOMException("unavailable", "SecurityError");
    },
    setItem: storage.setItem.bind(storage),
  } as unknown as Storage);
  try {
    expect(await reopened.send("new draft")).toBe(false);
    expect(reopened.controller.deliveryState(owner).storageIssue).toBe(
      "storage",
    );
  } finally {
    reads.mockRestore();
  }
  expect(sessionStorage.getItem(ledger)).toBe(saved);
  reopened.controller.loadDeliveries(owner);
  expect(reopened.observePrompt).toHaveBeenCalledExactlyOnceWith(
    original.receipt(),
    expect.any(AbortSignal),
  );
  expect(reopened.prompt).not.toHaveBeenCalled();
  confirmation.resolve(accepted);
  await vi.waitFor(() => expect(sessionStorage.getItem(ledger)).toBeNull());
  expect(reopened.draft().text).toBe("new draft");
  expect(await reopened.send("new draft")).toEqual(accepted);
  expect(reopened.prompt).toHaveBeenCalledOnce();
  expect(reopened.draft().text).toBe("");
  await vi.waitFor(() => expect(sessionStorage.getItem(ledger)).toBeNull());

  // Old records block fresh sends until the user stops tracking them.
  const unsupported = fixture();
  unsupported.prompt.mockResolvedValue(accepted);
  const old = '[{"old":true}]';
  sessionStorage.setItem(ledger, old);
  expect(await unsupported.send("new draft")).toBe(false);
  expect(unsupported.controller.deliveryState(owner).storageIssue).toBe(
    "format",
  );
  expect(sessionStorage.getItem(ledger)).toBe(old);
  expect(unsupported.prompt).not.toHaveBeenCalled();
  unsupported.controller.forgetUnsupportedDeliveries(owner);
  expect(sessionStorage.getItem(ledger)).toBeNull();
  expect(await unsupported.send("new draft")).toEqual(accepted);
  expect(unsupported.prompt).toHaveBeenCalledOnce();
});

it("can send a new draft after an unknown delivery without resubmitting its attachments", async () => {
  const f = fixture();
  await f.stage(image("original"));
  f.prompt
    .mockRejectedValueOnce(new ApiTransportError("request", true))
    .mockResolvedValue(accepted);
  f.observePrompt.mockRejectedValue(new ApiTransportError("request", true));

  expect(await f.send("First caption", "steer")).toBe(false);
  expect(f.controller.deliveryState(owner).previous).toBe(
    f.receipt().operationId,
  );
  expect(f.observePrompt).toHaveBeenCalledExactlyOnceWith(
    f.receipt(),
    expect.any(AbortSignal),
  );

  expect(await f.send("New message")).toEqual(accepted);
  expect(f.prompt.mock.calls[1]![0]).toMatchObject({ message: "New message" });
  expect(f.prompt.mock.calls[1]![0].attachmentIds).toBeUndefined();
  expect(f.receipt(1).operationId).not.toBe(f.receipt().operationId);
  expect(f.deleteAttachment).not.toHaveBeenCalled();
});

it("restages browser-held bytes from a failed delivery in its inactive partition after Host replacement", async () => {
  const f = fixture();
  const draftFile = file("draft.txt");
  await f.stage(uploaded("old-upload", draftFile.name), draftFile);
  f.upload(uploaded("new-upload", draftFile.name));
  f.prompt.mockRejectedValueOnce(new ApiError(409, "not sent"));
  const sending = f.send("send");
  f.select(other);
  f.edit("newer");
  f.edit("");
  expect(await sending).toBe(false);
  f.replaceTransport(nextAuthority);
  f.controller.reconcileAuthority(nextAuthority);
  expect(f.draft().attachments).toEqual([]);
  expect(f.controller.restoreFailedPrompt(owner)).toBe(true);
  expect(f.draft().text).toBe("send");
  await vi.waitFor(() =>
    expect(f.draft().attachments[0]).toMatchObject({
      status: "ready",
      uploadedId: "new-upload",
      uploadedAuthorityId: nextAuthority,
    }),
  );
  expect(f.uploadAttachments.mock.calls[1]![0]).toEqual([draftFile]);
  expect(f.draft(other).attachments).toEqual([]);
  expect(f.deleteAttachment).not.toHaveBeenCalled();
  expect(f.prompt).toHaveBeenCalledOnce();
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

it("retains local bytes through upload retry and cancels attempts after removal", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.uploadAttachments.mockRejectedValue(
    new ApiTransportError("request", true, true),
  );
  const kept = file("retained.txt");
  await f.controller.addFiles([kept, file("removed.txt")]);
  const [item, removed] = f.draft().attachments;
  expect(item?.status).toBe("uploading");
  expect(await f.send("message")).toBe(false);
  f.controller.removeAttachment(removed!.localId);
  await vi.advanceTimersByTimeAsync(14_000);
  expect(
    f.uploadAttachments.mock.calls.map(([files]) =>
      files.map(({ name }) => name),
    ),
  ).toEqual([
    [kept.name, "removed.txt"],
    [kept.name],
    [kept.name],
    [kept.name],
  ]);
  expect(f.prompt).not.toHaveBeenCalled();
  expect(f.draft().attachments[0]).toMatchObject({
    status: "error",
    retryable: true,
  });
  f.upload(uploaded("recovered", kept.name));
  await f.controller.retryAttachment(item!.localId);
  expect(f.uploadAttachments.mock.calls.at(-1)![0]).toEqual([kept]);
  expect(f.draft().attachments[0]).toMatchObject({
    localId: item!.localId,
    status: "ready",
    uploadedId: "recovered",
  });
});

it.each([
  ["withdrawal", ["one", "two"], []],
  ["transport replacement", ["one", "two"], ["uploading", "uploading"]],
  ["partial response", ["one"], ["error", "error"]],
] as const)(
  "reclaims unpublishable upload handles after %s",
  async (action, returned, statuses) => {
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
    } else if (action === "transport replacement") f.replaceTransport();
    expect(signal.aborted).toBe(action !== "partial response");
    reply.resolve({ attachments: returned.map((id) => uploaded(id)) });
    await staging;
    expect(f.deleteAttachment.mock.calls).toEqual(returned.map((id) => [id]));
    expect(f.draft().attachments.map(({ status }) => status)).toEqual(statuses);
    if (action === "partial response") {
      expect(await f.send("send")).toBe(false);
      expect(f.prompt).not.toHaveBeenCalled();
    }
  },
);
