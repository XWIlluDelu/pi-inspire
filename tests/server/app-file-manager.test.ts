import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showInFileManager } from "../../server/file-manager.js";
import { fileResourceReference } from "../../shared/resource-references.js";
import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./fixtures/host-api.js";

vi.mock("../../server/file-manager.js", () => ({
  showInFileManager: vi.fn().mockResolvedValue(undefined),
}));

describe("show in file manager authority", () => {
  let fixture: Awaited<ReturnType<typeof hostApiFixture>>;
  let project: string;
  let sessionId: string;
  beforeEach(async () => {
    vi.mocked(showInFileManager).mockReset().mockResolvedValue(undefined);
    fixture = await hostApiFixture();
    project = join(fixture.temporary, "project");
    await mkdir(project);
    await mkdir(join(project, "nested"));
    await writeFile(join(project, "literal%20name.md"), "content");
    await writeFile(join(fixture.temporary, "outside.md"), "outside");
    const opened = await request(fixture.application.server)
      .post("/api/sessions/new")
      .set("Authorization", `Bearer ${token}`)
      .send({ cwd: project })
      .expect(200);
    sessionId = opened.body.active.sessionId;
  });
  afterEach(async () => closeHostApiFixture(fixture));
  const reveal = (body: Record<string, unknown>) =>
    request(fixture.application.server)
      .post("/api/resources/show-in-file-manager")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, ...body });

  it("requires authentication before native integration", async () => {
    await request(fixture.application.server)
      .post("/api/resources/show-in-file-manager")
      .send({
        sessionId,
        reference: "literal%20name.md",
        workspacePath: "literal%20name.md",
      })
      .expect(401);
    expect(showInFileManager).not.toHaveBeenCalled();
  });

  it("shows exact workspace files and directories without interpreting filename escapes", async () => {
    const preview = await request(fixture.application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId,
        reference: "literal%20name.md",
        workspacePath: "literal%20name.md",
      })
      .expect(200);
    await reveal({
      reference: "literal%20name.md",
      workspacePath: "literal%20name.md",
    }).expect(200);
    expect(showInFileManager).toHaveBeenLastCalledWith(
      join(project, "literal%20name.md"),
      false,
    );
    const content = await request(fixture.application.server)
      .get(`/api/resources/${preview.body.id}/content`)
      .set("Authorization", `Bearer ${token}`)
      .query({ sessionId })
      .expect(200);
    expect(content.text).toBe("content");
    await reveal({
      reference: "nested",
      workspacePath: "nested",
      directory: true,
    }).expect(200);
    expect(showInFileManager).toHaveBeenLastCalledWith(
      join(project, "nested"),
      true,
    );
  });

  it("rejects missing, wrong-type and escaping paths before native integration", async () => {
    await reveal({
      reference: "missing.md",
      workspacePath: "missing.md",
    }).expect(404);
    await reveal({
      reference: "literal%20name.md",
      workspacePath: "literal%20name.md",
      directory: true,
    }).expect(400);
    await reveal({
      reference: "../outside.md",
      workspacePath: "../outside.md",
    }).expect(400);
    await reveal({
      reference: "../",
      workspacePath: "../",
      directory: true,
    }).expect(400);
    await reveal({ reference: "../outside.md" }).expect(403);
    expect(showInFileManager).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "rejects outside directory symlinks",
    async () => {
      await symlink(fixture.temporary, join(project, "outside"), "dir");
      await reveal({
        reference: "outside",
        workspacePath: "outside",
        directory: true,
      }).expect(403);
      expect(showInFileManager).not.toHaveBeenCalled();
    },
  );

  it("uses existing transcript authority for an outside referenced file", async () => {
    const outside = join(fixture.temporary, "outside.md");
    const context = await fixture.runtime.resourceContext(sessionId);
    vi.spyOn(fixture.runtime, "resourceContext").mockResolvedValue({
      sessionId: context.sessionId,
      viewId: context.viewId,
      revision: context.revision,
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
    await reveal({ reference: fileResourceReference(outside) }).expect(200);
    expect(showInFileManager).toHaveBeenCalledWith(outside, false);
  });

  it("returns desktop integration failures to the browser", async () => {
    vi.mocked(showInFileManager).mockRejectedValue(
      Object.assign(new Error("No desktop is available to show this item"), {
        status: 503,
      }),
    );
    const response = await reveal({
      reference: "nested",
      workspacePath: "nested",
      directory: true,
    }).expect(503);
    expect(response.body.error).toBe(
      "No desktop is available to show this item",
    );
  });
});
