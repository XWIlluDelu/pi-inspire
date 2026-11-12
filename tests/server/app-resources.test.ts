import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";

import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showInFileManager } from "../../server/file-manager.js";
import { ResourceStore } from "../../server/resources.js";
import { MAX_ATTACHMENT_FILE_BYTES } from "../../shared/contracts.js";
import {
  fileResourceReference,
  MAX_RESOURCE_REFERENCE_LENGTH,
} from "../../shared/resource-references.js";

import {
  closeHostApiFixture,
  hostApiFixture,
  pairedBrowser,
  token,
} from "./fixtures/host-api.js";

vi.mock("../../server/file-manager.js", () => ({
  showInFileManager: vi.fn(),
}));

describe("HTTP resource and upload authority", () => {
  type Fixture = Awaited<ReturnType<typeof hostApiFixture>>;
  let fixture: Fixture;
  let temporary: Fixture["temporary"];
  let resources: Fixture["resources"];
  let runtime: Fixture["runtime"];
  let baseUrl: Fixture["baseUrl"];
  let local: Fixture["localRequest"];
  let guest: ReturnType<typeof request>;
  beforeEach(async () => {
    vi.mocked(showInFileManager).mockReset().mockResolvedValue(undefined);
    fixture = await hostApiFixture();
    ({ temporary, resources, runtime, baseUrl, localRequest: local } = fixture);
    guest = request(fixture.application.server);
  });
  afterEach(async () => closeHostApiFixture(fixture));

  async function browser() {
    const { bearer } = await pairedBrowser(fixture.application.server, baseUrl);
    return request
      .agent(fixture.application.server)
      .set("Authorization", `Bearer ${bearer}`);
  }

  async function openProject(cwd = temporary, client = local): Promise<string> {
    const { body } = await client
      .post("/api/sessions/new")
      .send({ cwd })
      .expect(200);
    return body.active.sessionId;
  }

  it("allows URI escaping overhead without enlarging the literal workspace-path budget", async () => {
    await writeFile(join(temporary, "long-url.md"), "LONG_LINK_BYTES");
    const sessionId = await openProject();
    // A valid escaped relative URL whose native target is a short owned path.
    // No platform-dependent deep directory or overlong component is needed.
    const reference = "%2E/".repeat(2_100) + "long-url.md";
    const resolved = await local
      .post("/api/resources/resolve")
      .send({ sessionId, reference })
      .expect(200);
    expect(resolved.body.name).toBe("long-url.md");
    const content = await local
      .get(`/api/resources/${resolved.body.id}/content`)
      .query({ sessionId })
      .expect(200);
    expect(content.text).toBe("LONG_LINK_BYTES");
    await local
      .post("/api/resources/resolve")
      .send({
        sessionId,
        reference: "a".repeat(MAX_RESOURCE_REFERENCE_LENGTH + 1),
      })
      .expect(400);
    await local
      .post("/api/resources/resolve")
      .send({ sessionId, reference: "a".repeat(8_193) })
      .expect(400);
    await local
      .post("/api/resources/resolve")
      .send({
        sessionId,
        reference: "long-url.md",
        workspacePath: "a".repeat(8_193),
      })
      .expect(400);
  });

  it("streams only the one-use download's current session/view/resource and revalidates before bytes", async () => {
    const paired = await browser();
    const name = "report%20 draft.md";
    await writeFile(join(temporary, name), "complete raw download\n");
    const sessionId = await openProject(temporary, paired);
    const resolved = await paired
      .post("/api/resources/resolve")
      .send({
        sessionId,
        reference: name,
        workspacePath: name,
      })
      .expect(200);
    const id = resolved.body.id as string;
    const mint = async () => {
      const result = await paired
        .post(`/api/resources/${id}/download-ticket`)
        .send({ sessionId })
        .expect(200);
      return `/api/resource-downloads/${result.body.ticket}`;
    };
    await guest
      .post(`/api/resources/${id}/download-ticket`)
      .send({ sessionId })
      .expect(401);
    const url = await mint();
    await guest.get(url).expect(403);
    await guest.get(url).set("Sec-Fetch-Site", "same-site").expect(403);
    for (const headers of [
      { Referer: "https://foreign.invalid/" },
      { Referer: "not-a-url" },
      { Referer: baseUrl.replace("://", "://user:pass@") + "/" },
      { Referer: baseUrl + "/", "Sec-Fetch-Site": "cross-site" },
      { Referer: baseUrl + "/", "Sec-Fetch-Site": "none" },
      { Referer: baseUrl + "/", Origin: "null" },
      { Referer: baseUrl + "/", Origin: "https://foreign.invalid" },
      { Referer: "https://foreign.invalid/", Origin: baseUrl },
      {
        Referer: baseUrl + "/",
        Origin: baseUrl,
        "Sec-Fetch-Site": "cross-site",
      },
    ]) {
      await guest.get(url).set(headers).expect(403);
    }
    const referredDownload = await mint();
    await guest
      .get(referredDownload)
      .set("Referer", baseUrl + "/")
      .expect(200, "complete raw download\n");
    const bytes = await guest
      .get(url)
      .set("Sec-Fetch-Site", "same-origin")
      .expect(200);
    expect(bytes.text).toBe("complete raw download\n");
    const disposition = bytes.headers["content-disposition"]!;
    expect(disposition).toMatch(/^attachment; filename\*=UTF-8''/u);
    expect(decodeURIComponent(disposition.split("''")[1]!)).toBe(name);
    await guest.get(url).set("Sec-Fetch-Site", "same-origin").expect(401);
    const wrongOrigin = await mint();
    await guest
      .get(wrongOrigin)
      .set("Host", "localhost:55555")
      .set("Sec-Fetch-Site", "same-origin")
      .expect(401);
    const retiredView = await mint();
    const context = await runtime.resourceContext(sessionId);
    vi.spyOn(runtime, "resourceContext").mockResolvedValueOnce({
      ...context,
      viewId: "retired-view",
    });
    await guest
      .get(retiredView)
      .set("Sec-Fetch-Site", "same-origin")
      .expect(404);
    const stale = await mint();
    await rm(join(temporary, name));
    await guest.get(stale).set("Sec-Fetch-Site", "same-origin").expect(404);
    await guest.get(stale).set("Sec-Fetch-Site", "same-origin").expect(401);
  });

  it("validates hidden filters for saved and prospective workspace searches", async () => {
    await writeFile(join(temporary, ".env"), "SYNTHETIC_CONFIG=true\n");
    const sessionId = await openProject();
    for (const [endpoint, scope] of [
      ["/api/files", { sessionId }],
      ["/api/new-session/files", { cwd: temporary }],
    ] as const) {
      const search = (showHidden?: string) =>
        local.get(endpoint).query({
          ...scope,
          q: ".env",
          ...(showHidden ? { showHidden } : {}),
        });
      expect((await search().expect(200)).body.files).toEqual([]);
      expect((await search("1").expect(200)).body.files).toEqual([
        { name: ".env", path: ".env" },
      ]);
      await search("yes").expect(400);
    }
    await local
      .get("/api/files/list")
      .query({ sessionId, showHidden: "yes" })
      .expect(400);
    // Workspace filtering does not affect authorization of an exact path.
    const resolved = await local
      .post("/api/resources/resolve")
      .send({ sessionId, reference: ".env", workspacePath: ".env" })
      .expect(200);
    await local
      .get(`/api/resources/${resolved.body.id}/content`)
      .query({ sessionId })
      .expect(200, "SYNTHETIC_CONFIG=true\n");
  }, 30_000);

  it("serves only authenticated session-addressed Git status and diff inspection", async () => {
    await guest.get("/api/git/status?sessionId=fixture-active").expect(401);
    await local.get("/api/git/status?sessionId=not-open").expect(409);
    await local
      .post("/api/sessions/open")
      .send({ id: "fixture-active" })
      .expect(200);
    const status = await local
      .get("/api/git/status?sessionId=fixture-active")
      .expect(200);
    expect(status.body).toEqual({ kind: "not-repository" });
    expect(fixture.git.status).toHaveBeenCalledWith(
      fixture.cwd,
      expect.any(AbortSignal),
    );

    await local
      .post("/api/git/diff")
      .send({
        sessionId: "fixture-active",
        pathId: "not base64!",
      })
      .expect(400);
    const diff = await local
      .post("/api/git/diff")
      .send({
        sessionId: "fixture-active",
        pathId: "ZmlsZS50eHQ",
      })
      .expect(200);
    expect(diff.body).toMatchObject({ kind: "empty" });
    expect(fixture.git.diff).toHaveBeenCalledWith(
      fixture.cwd,
      "ZmlsZS50eHQ",
      expect.any(AbortSignal),
    );
  });

  it("reveals only authorized workspace paths and transcript citations in the file manager", async () => {
    const literalName = "literal%20name.md";
    await writeFile(join(fixture.cwd, literalName), "content");
    await mkdir(join(fixture.cwd, "nested"));
    await writeFile(join(temporary, "outside.md"), "outside");
    const revealPath = "/api/resources/show-in-file-manager";
    const sessionId = "fixture-active";
    const workspaceTarget = (path: string, directory?: boolean) => ({
      sessionId,
      reference: path,
      workspacePath: path,
      directory,
    });
    await local.post("/api/sessions/open").send({ id: sessionId }).expect(200);
    await guest.post(revealPath).send(workspaceTarget(literalName)).expect(401);
    const reveal = (body: object) => local.post(revealPath).send(body);

    const outside = join(temporary, "outside.md");
    const citation = { sessionId, reference: fileResourceReference(outside) };
    for (const [body, status] of [
      [workspaceTarget("missing.md"), 404],
      [workspaceTarget(literalName, true), 400],
      [workspaceTarget("../outside.md"), 400],
      [citation, 403],
    ] as const)
      await reveal(body).expect(status);
    if (process.platform !== "win32") {
      await symlink(temporary, join(fixture.cwd, "outside"), "dir");
      await reveal(workspaceTarget("outside", true)).expect(403);
    }
    expect(showInFileManager).not.toHaveBeenCalled();
    await reveal(workspaceTarget(literalName)).expect(200);
    await reveal(workspaceTarget("nested", true)).expect(200);

    const context = await runtime.resourceContext(sessionId);
    vi.spyOn(runtime, "resourceContext").mockResolvedValue({
      sessionId: context.sessionId,
      viewId: context.viewId,
      revision: context.revision + 1,
      cwd: context.cwd,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "read", arguments: { path: outside } },
          ],
        },
      ],
    });
    await reveal(citation).expect(200);
    expect(vi.mocked(showInFileManager).mock.calls).toEqual([
      [join(fixture.cwd, literalName), false],
      [join(fixture.cwd, "nested"), true],
      [outside, false],
    ]);
    vi.mocked(showInFileManager).mockRejectedValueOnce(
      Object.assign(new Error("No desktop is available to show this item"), {
        status: 503,
      }),
    );
    await reveal(citation).expect(503, {
      error: "No desktop is available to show this item",
    });
  });

  it("serves files and embedded images from the addressed session after selection changes", async () => {
    const sessionId = "fixture-active";
    const session = (await fixture.catalog.get(sessionId))!;
    const name =
      process.platform === "win32" ? "quoted'(x).md" : "quoted'(*).md";
    await writeFile(join(session.cwd, name), "# Host preview\n");
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=",
      "base64",
    );
    const parentId = JSON.parse(
      (await readFile(session.path, "utf8")).trim().split("\n").at(-1)!,
    ).id;
    const timestamp = Date.now();
    await appendFile(
      session.path,
      `${JSON.stringify({
        type: "message",
        id: "saved-image",
        parentId,
        timestamp: new Date(timestamp).toISOString(),
        message: {
          role: "user",
          timestamp,
          content: [
            { type: "text", text: "Retained picture" },
            {
              type: "image",
              mimeType: "image/png",
              data: image.toString("base64"),
            },
          ],
        },
      })}\n`,
    );
    const open = (id: string) =>
      local.post("/api/sessions/open").send({ id }).expect(200);
    await open(sessionId);
    const pending = await runtime.resourceContext(sessionId);
    const resolve = (reference: string) =>
      local.post("/api/resources/resolve").send({ sessionId, reference });
    const file = (await resolve(name).expect(200)).body;
    expect(file).toMatchObject({ name, kind: "markdown" });
    await resolve("../outside.txt").expect(403);

    const other = "fixture-history";
    await open(other);
    expect(await pending.loadMessages!()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "image",
              data: image.toString("base64"),
            }),
          ]),
        }),
      ]),
    );

    const listResources = () => local.post("/api/resources/list");
    const { body: list } = await listResources()
      .send({ sessionId })
      .expect(200);
    await listResources()
      .send({ sessionId, limit: 100 })
      .expect(200)
      .expect(({ body }) => expect(body.resources).toEqual(list.resources));
    const embedded = list.resources.find((resource: { reference: string }) =>
      resource.reference.startsWith("pi-embedded://"),
    );
    const savedImage = (await resolve(embedded.reference).expect(200)).body;
    expect(savedImage).toMatchObject({ kind: "image", size: image.length });
    await local
      .post("/api/resources/probe")
      .send({ sessionId, references: [name] })
      .expect(200)
      .expect(({ body }) =>
        expect(body.results).toMatchObject([
          { availability: "available", workspacePath: name },
        ]),
      );
    const content = (id: string, owner = sessionId) =>
      local.get(`/api/resources/${id}/content`).query({ sessionId: owner });
    await content(file.id)
      .expect(
        "Content-Disposition",
        process.platform === "win32"
          ? "inline; filename*=UTF-8''quoted%27%28x%29.md"
          : "inline; filename*=UTF-8''quoted%27%28%2A%29.md",
      )
      .expect(200, "# Host preview\n");
    await content(file.id)
      .query({ download: "1" })
      .expect("Content-Disposition", /^attachment;/)
      .expect(200, "# Host preview\n");
    await content(file.id)
      .set("Range", "bytes=0-5")
      .expect("Content-Range", "bytes 0-5/15")
      .expect(206, "# Host");
    await content(file.id).set("Range", "bytes=999-1000").expect(416);
    await content(file.id, other).expect(404);
    const ranged = await content(savedImage.id)
      .set("Range", "bytes=0-4")
      .expect("Content-Type", "image/png")
      .expect("Content-Range", `bytes 0-4/${image.length}`)
      .expect(206);
    expect(ranged.body).toEqual(image.subarray(0, 5));
    await content(savedImage.id, other).expect(404);
  });

  it("uses the current resource size after resolve when a file grows or shrinks", async () => {
    const resourcePath = join(temporary, "changing.md");
    await writeFile(resourcePath, "old\n");
    const sessionId = await openProject();
    const resolved = await local
      .post("/api/resources/resolve")
      .send({ sessionId, reference: "changing.md" })
      .expect(200);
    expect(resolved.body.size).toBe(4);

    const grown = "grown-content\n";
    await writeFile(resourcePath, grown);
    const grownResponse = await local
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Range", "bytes=0-262143")
      .expect(206);
    expect(grownResponse.headers["content-range"]).toBe(
      `bytes 0-${grown.length - 1}/${grown.length}`,
    );
    expect(grownResponse.text).toBe(grown);

    const shrunk = "new\n";
    await writeFile(resourcePath, shrunk);
    const shrunkResponse = await local
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Range", "bytes=0-262143")
      .expect(206);
    expect(shrunkResponse.headers["content-range"]).toBe(
      `bytes 0-${shrunk.length - 1}/${shrunk.length}`,
    );
    expect(shrunkResponse.text).toBe(shrunk);
  });

  it("closes an opened file when the client aborts during authorization", async () => {
    await writeFile(join(temporary, "slow.md"), "slow preview\n");
    const sessionId = await openProject();
    const resolved = await local
      .post("/api/resources/resolve")
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

  it("keeps staged uploads private and removes them on withdrawal", async () => {
    const directory = await fixture.attachments.uploadDirectory();
    const before = await readdir(directory);
    const uploaded = await local
      .post("/api/attachments")
      .attach("files", Buffer.from("draft"), {
        filename: "draft.txt",
        contentType: "text/plain",
      })
      .expect(200);
    const [attachment] = uploaded.body.attachments;
    expect(attachment).toMatchObject({ fileName: "draft.txt", kind: "file" });
    expect(attachment).not.toHaveProperty("path");
    const id = attachment.id as string;
    const stored = (await readdir(directory)).filter(
      (name) => !before.includes(name),
    );
    expect(stored.length).toBeGreaterThan(0);
    if (process.platform !== "win32") {
      for (const name of stored)
        expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
    await local.delete(`/api/attachments/${id}`).expect(200, { ok: true });
    expect(await readdir(directory)).toEqual(before);
    await local.delete(`/api/attachments/${id}`).expect(200, { ok: true });
    await local.delete("/api/attachments/not-a-uuid").expect(400);
  });

  it("rejects multipart batches at the aggregate streaming budget and removes partial files", async () => {
    const uploadDirectory = await fixture.attachments.uploadDirectory();
    const metadataBefore = await readdir(uploadDirectory);
    await local
      .post("/api/attachments")
      .attach("files", Buffer.alloc(MAX_ATTACHMENT_FILE_BYTES), {
        filename: "one.bin",
      })
      .attach("files", Buffer.alloc(MAX_ATTACHMENT_FILE_BYTES), {
        filename: "two.bin",
      })
      .attach("files", Buffer.alloc(1), { filename: "overflow.bin" })
      .expect(413);
    expect(await readdir(uploadDirectory)).toEqual(metadataBefore);
  }, 15_000);
});
