import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";

import { join, resolve } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceStore } from "../../server/resources.js";

import { MAX_ATTACHMENT_FILE_BYTES } from "../../shared/contracts.js";

import {
  hostApiFixture,
  closeHostApiFixture,
  token,
} from "./fixtures/host-api.js";

const mockWorkspace = resolve("/home/demo/research");

describe("HTTP resource and upload authority", () => {
  let temporary: Awaited<ReturnType<typeof hostApiFixture>>["temporary"];
  let application: Awaited<ReturnType<typeof hostApiFixture>>["application"];
  let resources: Awaited<ReturnType<typeof hostApiFixture>>["resources"];
  let runtime: Awaited<ReturnType<typeof hostApiFixture>>["runtime"];
  let git: Awaited<ReturnType<typeof hostApiFixture>>["git"];
  let baseUrl: Awaited<ReturnType<typeof hostApiFixture>>["baseUrl"];
  let promptDelivery: Awaited<
    ReturnType<typeof hostApiFixture>
  >["promptDelivery"];
  let fixture: Awaited<ReturnType<typeof hostApiFixture>>;
  beforeEach(async () => {
    fixture = await hostApiFixture();
    ({
      temporary,
      application,
      resources,
      runtime,
      git,
      baseUrl,
      promptDelivery,
    } = fixture);
  });
  afterEach(async () => closeHostApiFixture(fixture));

  // Multiple HTTP requests run real native hidden-attribute commands on the
  // host. This checks behavior, not a 5-second budget for the whole scenario.
  it("keeps file visibility and resource authority independent of Git through the HTTP API", async () => {
    await mkdir(join(temporary, "dist"));
    await mkdir(join(temporary, "empty"));
    await mkdir(join(temporary, ".git"));
    await writeFile(join(temporary, ".git", "index"), "corrupt Git fixture");
    await writeFile(join(temporary, ".gitignore"), "dist/\n");
    await writeFile(join(temporary, "dist", "report.md"), "# Ignored output\n");
    await writeFile(join(temporary, ".env"), "SYNTHETIC_CONFIG=true\n");
    const opened = await request(application.server)
      .post("/api/sessions/new")
      .set("Authorization", `Bearer ${token}`)
      .send({ cwd: temporary })
      .expect(200);
    const sessionId = opened.body.active.sessionId as string;
    const listing = await request(application.server)
      .get("/api/files/list")
      .query({ sessionId })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(listing.body).toMatchObject({
      entries: [
        { name: "dist", type: "dir" },
        { name: "empty", type: "dir" },
      ],
      truncated: false,
    });
    const hidden = await request(application.server)
      .get("/api/files/list")
      .query({ sessionId, showHidden: "1" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(hidden.body.entries).toContainEqual({ name: ".env", type: "file" });
    for (const endpoint of ["/api/files", "/api/new-session/files"]) {
      const query =
        endpoint === "/api/files" ? { sessionId } : { cwd: temporary };
      const visible = await request(application.server)
        .get(endpoint)
        .query({ ...query, q: "report" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(visible.body.files).toEqual([
        { name: "report.md", path: "dist/report.md" },
      ]);
      const excluded = await request(application.server)
        .get(endpoint)
        .query({ ...query, q: ".env" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(excluded.body.files).toEqual([]);
      const included = await request(application.server)
        .get(endpoint)
        .query({ ...query, q: ".env", showHidden: "1" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(included.body.files).toEqual([{ name: ".env", path: ".env" }]);
      await request(application.server)
        .get(endpoint)
        .query({ ...query, showHidden: "yes" })
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    }
    // Visibility is not access control, including when the file was never searched.
    const resolved = await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: ".env", workspacePath: ".env" })
      .expect(200);
    const downloaded = await request(application.server)
      .get(`/api/resources/${resolved.body.id}/content`)
      .query({ sessionId, download: "1" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(downloaded.text).toBe("SYNTHETIC_CONFIG=true\n");
  }, 30_000);

  it("serves only authenticated session-addressed Git status and diff inspection", async () => {
    await request(application.server)
      .get("/api/git/status?sessionId=mock-active")
      .expect(401);
    await request(application.server)
      .get("/api/git/status?sessionId=not-open")
      .set("Authorization", `Bearer ${token}`)
      .expect(409);
    await request(application.server)
      .post("/api/sessions/open")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "mock-active" })
      .expect(200);
    const status = await request(application.server)
      .get("/api/git/status?sessionId=mock-active")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(status.body).toEqual({ kind: "not-repository" });
    expect(git.status).toHaveBeenCalledWith(
      mockWorkspace,
      expect.any(AbortSignal),
    );

    await request(application.server)
      .post("/api/git/diff")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId: "mock-active",
        pathId: "not base64!",
        side: "unstaged",
      })
      .expect(400);
    await request(application.server)
      .post("/api/git/diff")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId: "mock-active",
        pathId: "ZmlsZS50eHQ",
        side: "working",
      })
      .expect(400);
    const diff = await request(application.server)
      .post("/api/git/diff")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId: "mock-active",
        pathId: "ZmlsZS50eHQ",
        side: "unstaged",
      })
      .expect(200);
    expect(diff.body).toMatchObject({ kind: "empty", side: "unstaged" });
    expect(git.diff).toHaveBeenCalledWith(
      mockWorkspace,
      "ZmlsZS50eHQ",
      "unstaged",
      expect.any(AbortSignal),
    );

    for (const route of [
      "add",
      "commit",
      "restore",
      "checkout",
      "history",
      "blame",
      "push",
    ]) {
      await request(application.server)
        .post(`/api/git/${route}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ sessionId: "mock-active" })
        .expect(404);
    }
  });

  it("serves workspace files independently of discovery while keeping session and outside-path boundaries", async () => {
    const quotedName =
      process.platform === "win32" ? "quoted'(x).md" : "quoted'(*).md";
    await writeFile(join(temporary, "preview.md"), "# Host preview\n");
    await writeFile(join(temporary, "notes.txt"), "workspace note\n");
    await writeFile(join(temporary, quotedName), "quoted\n");
    await mkdir(join(temporary, "node_modules"));
    await writeFile(
      join(temporary, "node_modules", "mentioned.txt"),
      "vendored but cited\n",
    );
    await writeFile(
      join(temporary, "node_modules", "hidden.txt"),
      "vendored\n",
    );
    const opened = await request(application.server)
      .post("/api/sessions/new")
      .set("Authorization", `Bearer ${token}`)
      .send({ cwd: temporary })
      .expect(200);
    const sessionId = opened.body.active.sessionId as string;
    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send(
        promptDelivery({
          sessionId,
          message:
            "Open [the preview](preview.md), [the vendored note](node_modules/mentioned.txt), and `missing.md`.",
        }),
      )
      .expect(202);

    const listed = await request(application.server)
      .post("/api/resources/list")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId })
      .expect(200);
    expect(listed.body).toMatchObject({ sessionId });
    expect(listed.body.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reference: "preview.md" }),
        expect.objectContaining({ reference: "node_modules/mentioned.txt" }),
        expect.objectContaining({ reference: "missing.md" }),
      ]),
    );

    const probed = await request(application.server)
      .post("/api/resources/probe")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId,
        references: ["preview.md", "missing.md", "node_modules/hidden.txt"],
      })
      .expect(200);
    expect(probed.body).toMatchObject({
      sessionId,
      revision: expect.any(Number),
      results: [
        { reference: "preview.md", availability: "available" },
        { reference: "missing.md", availability: "missing" },
        { reference: "node_modules/hidden.txt", availability: "available" },
      ],
    });

    const resolved = await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "preview.md" })
      .expect(200);
    expect(resolved.body).toMatchObject({
      name: "preview.md",
      kind: "markdown",
    });

    const content = await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(content.text).toBe("# Host preview\n");
    expect(content.headers["accept-ranges"]).toBe("bytes");
    expect(content.headers["content-disposition"]).toBe(
      "inline; filename*=UTF-8''preview.md",
    );

    const download = await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}&download=1`,
      )
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(download.text).toBe("# Host preview\n");
    expect(download.headers["content-disposition"]).toBe(
      "attachment; filename*=UTF-8''preview.md",
    );

    // A head-slice Range (how the client caps text previews) yields 206.
    const ranged = await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .set("Range", "bytes=0-5")
      .expect(206);
    expect(ranged.headers["content-range"]).toBe("bytes 0-5/15");
    expect(ranged.text).toBe("# Host");
    // Invalid ranges must not fall back to serving the complete file.
    await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .set("Range", "bytes=999-1000")
      .expect(416);

    // Indexed workspace files preview without a transcript mention — the
    // explorer's click path.
    await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId,
        reference: "notes.txt",
        workspacePath: "notes.txt",
      })
      .expect(200);
    const quoted = await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId,
        reference: quotedName,
        workspacePath: quotedName,
      })
      .expect(200);
    const quotedContent = await request(application.server)
      .get(
        `/api/resources/${quoted.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(quotedContent.headers["content-disposition"]).toBe(
      process.platform === "win32"
        ? "inline; filename*=UTF-8''quoted%27%28x%29.md"
        : "inline; filename*=UTF-8''quoted%27%28%2A%29.md",
    );
    // A transcript mention still reaches files the index ignores.
    await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "node_modules/mentioned.txt" })
      .expect(200);
    // Workspace containment, not Git/search membership, authorizes this file.
    await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "node_modules/hidden.txt" })
      .expect(200);
    await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "unmentioned.txt" })
      .expect(404);
    await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "../outside.txt" })
      .expect(403);

    // A second browser selecting another session does not revoke this
    // browser's addressed resource operations or existing handles.
    await request(application.server)
      .post("/api/sessions/open")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "mock-active" })
      .expect(200);
    await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    for (const [operation, body] of [
      ["list", { sessionId }],
      ["probe", { sessionId, references: ["preview.md"] }],
      ["resolve", { sessionId, reference: "preview.md" }],
    ] as const) {
      await request(application.server)
        .post(`/api/resources/${operation}`)
        .set("Authorization", `Bearer ${token}`)
        .send(body)
        .expect(200);
    }
    await request(application.server)
      .get(`/api/resources/${resolved.body.id}/content?sessionId=mock-active`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });

  it("uses the current resource size after resolve when a file grows or shrinks", async () => {
    const resourcePath = join(temporary, "changing.md");
    await writeFile(resourcePath, "old\n");
    const opened = await request(application.server)
      .post("/api/sessions/new")
      .set("Authorization", `Bearer ${token}`)
      .send({ cwd: temporary })
      .expect(200);
    const sessionId = opened.body.active.sessionId as string;
    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send(
        promptDelivery({
          sessionId,
          message: "Open [changing](changing.md).",
        }),
      )
      .expect(202);
    const resolved = await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "changing.md" })
      .expect(200);
    expect(resolved.body.size).toBe(4);

    const grown = "grown-content\n";
    await writeFile(resourcePath, grown);
    const grownResponse = await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .set("Range", "bytes=0-262143")
      .expect(206);
    expect(grownResponse.headers["content-range"]).toBe(
      `bytes 0-${grown.length - 1}/${grown.length}`,
    );
    expect(grownResponse.text).toBe(grown);

    const shrunk = "new\n";
    await writeFile(resourcePath, shrunk);
    const shrunkResponse = await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .set("Range", "bytes=0-262143")
      .expect(206);
    expect(shrunkResponse.headers["content-range"]).toBe(
      `bytes 0-${shrunk.length - 1}/${shrunk.length}`,
    );
    expect(shrunkResponse.text).toBe(shrunk);
  });

  it("closes an opened file when the client aborts during authorization", async () => {
    await writeFile(join(temporary, "slow.md"), "slow preview\n");
    const openedSession = await request(application.server)
      .post("/api/sessions/new")
      .set("Authorization", `Bearer ${token}`)
      .send({ cwd: temporary })
      .expect(200);
    const sessionId = openedSession.body.active.sessionId as string;
    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send(promptDelivery({ sessionId, message: "Open [slow](slow.md)." }))
      .expect(202);
    const resolved = await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "slow.md" })
      .expect(200);

    let releaseOpen!: () => void;
    const gate = new Promise<void>(
      (resolveGate) => (releaseOpen = resolveGate),
    );
    let opened!: () => void;
    const openedHandle = new Promise<void>(
      (resolveOpened) => (opened = resolveOpened),
    );
    let handle:
      | Awaited<ReturnType<ResourceStore["openForServing"]>>["handle"]
      | null = null;
    const openForServing = resources.openForServing.bind(resources);
    resources.openForServing = async (resource) => {
      const result = await openForServing(resource);
      handle = result.handle;
      opened();
      await gate;
      return result;
    };

    const controller = new AbortController();
    const fetching = fetch(
      `${baseUrl}/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    ).catch((error: Error) => error);
    await openedHandle;
    controller.abort();
    const failure = await fetching;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("AbortError");
    releaseOpen();

    await vi.waitFor(async () => {
      await expect(handle!.stat()).rejects.toMatchObject({ code: "EBADF" });
    });
  });

  it("honors byte ranges for embedded resources as well as filesystem files", async () => {
    const sessionId = "embedded-session";
    vi.spyOn(runtime, "resourceContext").mockImplementation(
      async (requestedSessionId) => {
        if (requestedSessionId !== sessionId)
          throw Object.assign(new Error("Wrong session"), { status: 409 });
        return {
          sessionId,
          viewId: "embedded-view",
          revision: 1,
          cwd: temporary,
          messages: [
            {
              role: "toolResult",
              content: [
                {
                  type: "image",
                  data: Buffer.from("image-bytes").toString("base64"),
                  mimeType: "image/png",
                },
              ],
            },
          ],
        };
      },
    );
    const resolved = await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "pi-embedded://0/0" })
      .expect(200);
    const ranged = await request(application.server)
      .get(`/api/resources/${resolved.body.id}/content?sessionId=${sessionId}`)
      .set("Authorization", `Bearer ${token}`)
      .set("Range", "bytes=0-4")
      .expect(206);
    expect(ranged.headers["content-range"]).toBe("bytes 0-4/11");
    expect(Buffer.from(ranged.body).toString()).toBe("image");
  });

  it("deletes withdrawn attachments from the host cache", async () => {
    const uploaded = await request(application.server)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", Buffer.from("draft"), {
        filename: "draft.txt",
        contentType: "text/plain",
      })
      .expect(200);
    const id = uploaded.body.attachments[0].id as string;
    await request(application.server)
      .delete(`/api/attachments/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200, { ok: true });
    // Idempotent: a second delete of the same id still succeeds.
    await request(application.server)
      .delete(`/api/attachments/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200, { ok: true });
    await request(application.server)
      .delete("/api/attachments/not-a-uuid")
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
  });

  it("rejects multipart batches at the aggregate streaming budget and removes partial files", async () => {
    await request(application.server)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", Buffer.alloc(MAX_ATTACHMENT_FILE_BYTES), {
        filename: "one.bin",
      })
      .attach("files", Buffer.alloc(MAX_ATTACHMENT_FILE_BYTES), {
        filename: "two.bin",
      })
      .attach("files", Buffer.alloc(1), { filename: "overflow.bin" })
      .expect(413);
    expect(await readdir(join(temporary, "uploads"))).toEqual([]);
  }, 15_000);

  it("accepts a bounded private upload and delivers its handle through the prompt API", async () => {
    await request(application.server)
      .post("/api/sessions/open")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "mock-active" })
      .expect(200);

    const uploaded = await request(application.server)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", Buffer.from("research notes"), {
        filename: "notes.txt",
        contentType: "text/plain",
      })
      .expect(200);
    expect(uploaded.body.attachments[0]).toMatchObject({
      fileName: "notes.txt",
      kind: "file",
      size: 14,
    });
    expect(uploaded.body.attachments[0]).not.toHaveProperty("path");
    const storedFiles = await readdir(join(temporary, "uploads"));
    const id = uploaded.body.attachments[0].id;
    expect(storedFiles.sort()).toEqual(
      [`${id}-notes.txt`, `${id}.json`].sort(),
    );
    const ownership = JSON.parse(
      await readFile(join(temporary, "uploads", `${id}.json`), "utf8"),
    );
    expect(ownership).toMatchObject({
      id,
      kind: "file",
      fileName: "notes.txt",
      path: join(temporary, "uploads", `${id}-notes.txt`),
    });
    if (process.platform !== "win32") {
      expect(
        (await stat(join(temporary, "uploads", `${id}-notes.txt`))).mode &
          0o777,
      ).toBe(0o600);
    }

    const prompt = vi.spyOn(runtime, "prompt");
    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send(
        promptDelivery({
          sessionId: "mock-active",
          message: "Integrate this note",
          attachmentIds: [uploaded.body.attachments[0].id],
        }),
      )
      .expect(202, {
        accepted: true,
        historyEntry: {
          text: "Integrate this note",
          images: [],
          files: [],
        },
      });

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "mock-active",
        message: "Integrate this note",
        attachmentIds: [id],
      }),
    );
  });
});
