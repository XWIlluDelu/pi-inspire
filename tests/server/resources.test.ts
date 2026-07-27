import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResourceStore, referencePath } from "../../server/resources.js";

const temporaryDirectories: string[] = [];

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "inspire-resources-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  await mkdir(project);
  return { root, project };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ResourceStore", () => {
  let resources: ResourceStore;

  beforeEach(() => {
    resources = new ResourceStore();
  });

  it("opens project-local files without granting a different session the handle", async () => {
    const { project } = await workspace();
    await writeFile(join(project, "report.md"), "# Result\n");
    const messages = [{ role: "assistant", content: [{ type: "text", text: "[report](report.md#L1)" }] }];
    const descriptor = await resources.resolve({ sessionId: "s1", cwd: project, messages }, "report.md#L1");

    expect(descriptor).toMatchObject({
      sessionId: "s1",
      name: "report.md",
      mimeType: "text/markdown",
      kind: "markdown",
    });
    expect(resources.get(descriptor.id, "s1").path).toBe(join(project, "report.md"));
    expect(() => resources.get(descriptor.id, "s2")).toThrow("no longer available");
  });

  it("does not load the transcript for an indexed workspace file", async () => {
    const { project } = await workspace();
    await writeFile(join(project, "indexed.txt"), "indexed\n");
    let messageLoads = 0;

    const descriptor = await resources.resolve(
      {
        sessionId: "s1",
        cwd: project,
        loadMessages: async () => {
          messageLoads += 1;
          return [];
        },
      },
      "indexed.txt",
    );

    expect(descriptor.name).toBe("indexed.txt");
    expect(messageLoads).toBe(0);
  });

  it("binds serving to the inode inspected at resolve, refusing a swapped file", async () => {
    const { root, project } = await workspace();
    await writeFile(join(project, "report.md"), "# Result\n");
    await writeFile(join(root, "secret.txt"), "SECRET\n");
    const messages = [{ role: "assistant", content: [{ type: "text", text: "[report](report.md)" }] }];
    const descriptor = await resources.resolve({ sessionId: "s1", cwd: project, messages }, "report.md");
    const resource = resources.get(descriptor.id, "s1");
    const opened = await resources.openForServing(resource);
    expect(opened.size).toBe("# Result\n".length);
    const original = await opened.handle.readFile("utf8");
    expect(original).toBe("# Result\n");
    await opened.handle.close();

    // Swapping the file for a symlink to an outside secret changes its inode:
    // the read is refused, never followed to the new target.
    const { rm } = await import("node:fs/promises");
    await rm(join(project, "report.md"));
    await symlink(join(root, "secret.txt"), join(project, "report.md"));
    await expect(resources.openForServing(resource)).rejects.toMatchObject({ status: 409 });

    // Same-path regeneration is a new inode too: the stale handle must be
    // re-resolved rather than silently serving different bytes.
    await rm(join(project, "report.md"));
    await writeFile(join(project, "report.md"), "# Regenerated\n");
    await expect(resources.openForServing(resource)).rejects.toMatchObject({ status: 409 });
  });

  it("allows a file only when the owning session explicitly references it", async () => {
    const { root, project } = await workspace();
    const artifact = join(root, "artifact.pdf");
    await writeFile(artifact, "%PDF-test");

    await expect(resources.resolve({ sessionId: "s1", cwd: project, messages: [] }, artifact)).rejects.toMatchObject({ status: 403 });

    const messages = [{
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: artifact } }],
    }];
    const descriptor = await resources.resolve({ sessionId: "s1", cwd: project, messages }, artifact);
    expect(descriptor).toMatchObject({ name: "artifact.pdf", mimeType: "application/pdf", kind: "pdf" });
  });

  it("recognizes Pi-style file URLs and Markdown local links", async () => {
    const { root, project } = await workspace();
    const image = join(root, "chart one.png");
    await writeFile(image, "png");
    const href = pathToFileURL(image).href;
    const messages = [{ role: "assistant", content: [{ type: "text", text: `[chart](<${href}>)` }] }];

    const descriptor = await resources.resolve({ sessionId: "s1", cwd: project, messages }, href);
    expect(descriptor).toMatchObject({ name: "chart one.png", kind: "image" });
    expect(referencePath(`${href}#L2`, project)).toBe(image);
  });

  it("serves full embedded Pi image blocks through an opaque handle", async () => {
    const { project } = await workspace();
    const messages = [{ role: "toolResult", content: [{ type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" }] }];
    const descriptor = await resources.resolve({ sessionId: "s1", cwd: project, messages }, "pi-embedded://0/0");
    const resolved = resources.get(descriptor.id, "s1");
    expect(descriptor).toMatchObject({ kind: "image", mimeType: "image/png", size: 11 });
    expect((await resources.embeddedData(resolved, { sessionId: "s1", cwd: project, messages })).toString()).toBe("image-bytes");
  });

  it("does not treat a project symlink as authority for an outside file", async () => {
    const { root, project } = await workspace();
    const secret = join(root, "outside.txt");
    await writeFile(secret, "outside");
    await symlink(secret, join(project, "linked.txt"));

    await expect(resources.resolve({ sessionId: "s1", cwd: project, messages: [] }, "linked.txt")).rejects.toMatchObject({ status: 403 });
  });

  it("keeps a git-indexed symlink inside the workspace boundary", async () => {
    const { root, project } = await workspace();
    const secret = join(root, "outside.txt");
    await writeFile(secret, "outside");
    await symlink(secret, join(project, "linked.txt"));
    // A git cwd indexes the symlink itself (ls-files -co), unlike the
    // bounded walk — index membership must still not follow it outside.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["-C", project, "init", "-q"]);

    await expect(resources.resolve({ sessionId: "s1", cwd: project, messages: [] }, "linked.txt")).rejects.toMatchObject({ status: 403 });
  });
});
