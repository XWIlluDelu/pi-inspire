import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listProjectDirectory } from "../../server/project-files.js";
import { ResourceStore, referencePath } from "../../server/resources.js";

const temporaryDirectories: string[] = [];
let resources = new ResourceStore();

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "inspire-resources-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  await mkdir(project);
  return { root, project };
}

function resourceIdentity(viewId = "view-s1", revision = 1) {
  return { sessionId: "s1", viewId, revision };
}

afterEach(async () => {
  await resources.close();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ResourceStore", () => {
  beforeEach(() => {
    resources = new ResourceStore();
  });

  it("paginates one revision-bound citation index without retaining message content", async () => {
    const { project } = await workspace();
    let messageLoads = 0;
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: "assistant",
      content: [{ type: "text", text: `See \`file-${index}.md\`.` }],
    }));
    const context = {
      sessionId: "s1",
      viewId: "view-s1",
      revision: 7,
      cwd: project,
      loadMessages: async () => {
        messageLoads += 1;
        return messages;
      },
    };

    const first = await resources.list(context);
    expect(first).toMatchObject({ offset: 0, total: 20 });
    expect(first.resources).toHaveLength(8);
    expect(first.resources[0]?.reference).toBe("file-19.md");
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await resources.list(context, {
      cursor: first.nextCursor!,
      limit: 10,
    });
    expect(second).toMatchObject({ offset: 8, total: 20 });
    expect(second.resources).toHaveLength(10);
    expect(second.resources[0]?.reference).toBe("file-11.md");
    expect(second.nextCursor).toEqual(expect.any(String));

    await resources.probe(context, ["file-19.md", "file-0.md"]);
    expect(messageLoads).toBe(1);
    await expect(
      resources.list(
        { ...context, revision: 8 },
        { cursor: first.nextCursor! },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("keeps the newest revision cached when an older index completes later", async () => {
    const { project } = await workspace();
    let resolveOlder!: (messages: unknown[]) => void;
    let resolveNewer!: (messages: unknown[]) => void;
    const olderMessages = new Promise<unknown[]>((resolve) => {
      resolveOlder = resolve;
    });
    const newerMessages = new Promise<unknown[]>((resolve) => {
      resolveNewer = resolve;
    });
    let olderLoads = 0;
    let newerLoads = 0;
    const olderContext = {
      sessionId: "s1",
      viewId: "view-s1",
      revision: 7,
      cwd: project,
      loadMessages: () => {
        olderLoads += 1;
        return olderMessages;
      },
    };
    const newerContext = {
      ...olderContext,
      revision: 8,
      loadMessages: () => {
        newerLoads += 1;
        return newerMessages;
      },
    };

    const olderList = resources.list(olderContext);
    const newerList = resources.list(newerContext);
    resolveNewer([
      {
        role: "assistant",
        content: [{ type: "text", text: "See `newer.md`." }],
      },
    ]);
    await expect(newerList).resolves.toMatchObject({ total: 1 });
    resolveOlder([
      {
        role: "assistant",
        content: [{ type: "text", text: "See `older.md`." }],
      },
    ]);
    await expect(olderList).resolves.toMatchObject({ total: 1 });

    await expect(resources.list(newerContext)).resolves.toMatchObject({
      total: 1,
    });
    expect({ olderLoads, newerLoads }).toEqual({
      olderLoads: 1,
      newerLoads: 1,
    });
  });

  it("opens project-local files without granting a different session the handle", async () => {
    const { project } = await workspace();
    await writeFile(join(project, "report.md"), "# Result\n");
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "[report](report.md#L1)" }],
      },
    ];
    const descriptor = await resources.resolve(
      { ...resourceIdentity(), cwd: project, messages },
      "report.md#L1",
    );

    expect(descriptor).toMatchObject({
      sessionId: "s1",
      name: "report.md",
      mimeType: "text/markdown",
      kind: "markdown",
    });
    expect(resources.get(descriptor.id, "s1", descriptor.viewId).path).toBe(
      join(project, "report.md"),
    );
    expect(() => resources.get(descriptor.id, "s2", descriptor.viewId)).toThrow(
      "no longer available",
    );
  });

  it("binds citation handles to one branch view while allowing same-view append revalidation", async () => {
    const { project } = await workspace();
    await mkdir(join(project, "node_modules"));
    await writeFile(
      join(project, "node_modules", "branch-only.txt"),
      "branch A\n",
    );
    const citation = {
      role: "assistant",
      content: [
        { type: "text", text: "[branch](node_modules/branch-only.txt)" },
      ],
    };
    const contextA = {
      ...resourceIdentity("view-a"),
      cwd: project,
      messages: [citation],
    };
    const descriptor = await resources.resolve(
      contextA,
      "node_modules/branch-only.txt",
    );
    const resource = resources.get(descriptor.id, "s1", "view-a");

    await expect(
      resources.revalidate(resource, {
        ...contextA,
        messages: [citation, { role: "assistant", content: "append" }],
      }),
    ).resolves.toBeUndefined();
    expect(() => resources.get(descriptor.id, "s1", "view-b")).toThrow(
      "no longer available",
    );
    await expect(
      resources.revalidate(resource, {
        ...resourceIdentity("view-b"),
        cwd: project,
        messages: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("preflights availability without retaining preview handles and shares one lazy transcript load", async () => {
    const { project } = await workspace();
    await writeFile(join(project, "visible.md"), "visible\n");
    await mkdir(join(project, "node_modules"));
    await writeFile(join(project, "node_modules", "hidden.md"), "hidden\n");
    let messageLoads = 0;
    const context = {
      ...resourceIdentity(),
      cwd: project,
      loadMessages: async () => {
        messageLoads += 1;
        return [
          {
            role: "assistant",
            content: [{ type: "text", text: "See `missing.md`." }],
          },
        ];
      },
    };

    const results = await resources.probe(context, [
      "visible.md",
      "missing.md",
      "node_modules/hidden.md",
      "file://%",
    ]);

    expect(results).toEqual([
      {
        reference: "visible.md",
        availability: "available",
        workspacePath: "visible.md",
      },
      {
        reference: "missing.md",
        availability: "missing",
        message: "The referenced file was not found",
      },
      {
        reference: "node_modules/hidden.md",
        availability: "unavailable",
        message:
          "The file is not part of this session's workspace or transcript",
      },
      {
        reference: "file://%",
        availability: "invalid",
        message: "The file reference is not valid",
      },
    ]);
    expect(messageLoads).toBe(1);
  });

  it("does not load the transcript for an indexed workspace file", async () => {
    const { project } = await workspace();
    await writeFile(join(project, "indexed.txt"), "indexed\n");
    let messageLoads = 0;

    const descriptor = await resources.resolve(
      {
        ...resourceIdentity(),
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

  it("anchors serving to the resolved inode while observing same-file rewrites", async () => {
    const { root, project } = await workspace();
    await writeFile(join(project, "report.md"), "# Result\n");
    await writeFile(join(root, "secret.txt"), "SECRET\n");
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "[report](report.md)" }],
      },
    ];
    const descriptor = await resources.resolve(
      { ...resourceIdentity(), cwd: project, messages },
      "report.md",
    );
    const resource = resources.get(descriptor.id, "s1", descriptor.viewId);
    const opened = await resources.openForServing(resource);
    expect(opened.size).toBe("# Result\n".length);
    const original = await opened.handle.readFile("utf8");
    expect(original).toBe("# Result\n");
    await opened.handle.close();

    // A legitimate rewrite retains the authorized filesystem object. Serving
    // opens a fresh handle, so it reports current bytes rather than stale
    // resolve-time metadata.
    await writeFile(join(project, "report.md"), "# Rewritten in place\n");
    const rewritten = await resources.openForServing(resource);
    expect(await rewritten.handle.readFile("utf8")).toBe(
      "# Rewritten in place\n",
    );
    await rewritten.handle.close();

    // Swapping the file for a symlink to an outside secret is rejected before
    // following the link.
    const { rm } = await import("node:fs/promises");
    await rm(join(project, "report.md"));
    await symlink(join(root, "secret.txt"), join(project, "report.md"));
    await expect(resources.openForServing(resource)).rejects.toMatchObject({
      status: 409,
    });

    // Same-path regeneration would otherwise be able to reuse an inode on
    // some filesystems. The retained anchor keeps the original inode live, so
    // the stale handle must be re-resolved rather than serving new bytes.
    await rm(join(project, "report.md"));
    await writeFile(join(project, "report.md"), "# Regenerated\n");
    await expect(resources.openForServing(resource)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("allows a file only when the owning session explicitly references it", async () => {
    const { root, project } = await workspace();
    const artifact = join(root, "artifact.pdf");
    await writeFile(artifact, "%PDF-test");

    await expect(
      resources.resolve(
        { ...resourceIdentity(), cwd: project, messages: [] },
        artifact,
      ),
    ).rejects.toMatchObject({ status: 403 });

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: { path: artifact },
          },
        ],
      },
    ];
    const descriptor = await resources.resolve(
      { ...resourceIdentity("view-s1", 2), cwd: project, messages },
      artifact,
    );
    expect(descriptor).toMatchObject({
      name: "artifact.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
    });
  });

  it("recognizes Pi-style file URLs and Markdown local links", async () => {
    const { root, project } = await workspace();
    const image = join(root, "chart one.png");
    await writeFile(image, "png");
    const href = pathToFileURL(image).href;
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: `[chart](<${href}>)` }],
      },
    ];

    const descriptor = await resources.resolve(
      { ...resourceIdentity(), cwd: project, messages },
      href,
    );
    expect(descriptor).toMatchObject({ name: "chart one.png", kind: "image" });
    expect(referencePath(`${href}#L2`, project)).toBe(image);
  });

  it("serves full embedded Pi image blocks through an opaque handle", async () => {
    const { project } = await workspace();
    const messages = [
      {
        role: "toolResult",
        content: [
          { type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" },
        ],
      },
    ];
    const descriptor = await resources.resolve(
      { ...resourceIdentity(), cwd: project, messages },
      "pi-embedded://0/0",
    );
    const resolved = resources.get(descriptor.id, "s1", descriptor.viewId);
    expect(descriptor).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      size: 11,
    });
    expect(
      (
        await resources.embeddedData(resolved, {
          ...resourceIdentity(),
          cwd: project,
          messages,
        })
      ).toString(),
    ).toBe("image-bytes");
  });

  it("does not treat a project symlink as authority for an outside file", async () => {
    const { root, project } = await workspace();
    const secret = join(root, "outside.txt");
    await writeFile(secret, "outside");
    await symlink(secret, join(project, "linked.txt"));

    await expect(
      resources.resolve(
        { ...resourceIdentity(), cwd: project, messages: [] },
        "linked.txt",
      ),
    ).rejects.toMatchObject({ status: 403 });
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

    await expect(
      resources.resolve(
        { ...resourceIdentity(), cwd: project, messages: [] },
        "linked.txt",
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("recovers a bare mention when exactly one indexed file carries that name", async () => {
    const { project } = await workspace();
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "kernel.py"), "print('k')\n");
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "the loop lives in `kernel.py`" }],
      },
    ];

    const descriptor = await resources.resolve(
      { ...resourceIdentity(), cwd: project, messages },
      "kernel.py",
    );
    // The descriptor reports where it actually resolved, never the shorthand.
    expect(descriptor).toMatchObject({
      name: "kernel.py",
      reference: join("src", "kernel.py"),
    });
    expect(resources.get(descriptor.id, "s1", descriptor.viewId).path).toBe(
      join(project, "src", "kernel.py"),
    );
  });

  it("refuses to guess between duplicate basenames and offers the candidates", async () => {
    const { project } = await workspace();
    await mkdir(join(project, "a"));
    await mkdir(join(project, "b"));
    await writeFile(join(project, "a", "notes.md"), "a\n");
    await writeFile(join(project, "b", "notes.md"), "b\n");
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "compare `notes.md`" }],
      },
    ];

    await expect(
      resources.resolve(
        { ...resourceIdentity(), cwd: project, messages },
        "notes.md",
      ),
    ).rejects.toMatchObject({
      status: 409,
      matches: expect.arrayContaining([
        join("a", "notes.md"),
        join("b", "notes.md"),
      ]),
    });
  });

  it("never recovers a reference that makes its own location claim", async () => {
    const { project } = await workspace();
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "kernel.py"), "print('k')\n");
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "see `docs/kernel.py` and `absent.py`" },
        ],
      },
    ];
    const context = { ...resourceIdentity(), cwd: project, messages };

    // A located path names one file and no other; a bare name with no match
    // stays unavailable rather than being resolved to something nearby.
    await expect(
      resources.resolve(context, "docs/kernel.py"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(resources.resolve(context, "absent.py")).rejects.toMatchObject(
      { status: 404 },
    );
  });

  it("stops offering a tracked path whose file is gone, rescanning after the failed preview", async () => {
    const { project } = await workspace();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = (...args: string[]) =>
      promisify(execFile)("git", ["-C", project, ...args]);
    await git("init", "-q");
    await writeFile(join(project, "kept.txt"), "kept\n");
    await writeFile(join(project, "gone.txt"), "gone\n");
    await git("add", "-A");
    // Warm the index while both files exist.
    expect(
      (await listProjectDirectory(project)).map((entry) => entry.name),
    ).toEqual(["gone.txt", "kept.txt"]);

    const { rm } = await import("node:fs/promises");
    await rm(join(project, "gone.txt"));
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "wrote `gone.txt`" }],
      },
    ];
    await expect(
      resources.resolve(
        { ...resourceIdentity(), cwd: project, messages },
        "gone.txt",
      ),
    ).rejects.toMatchObject({ status: 404 });

    // The failed preview invalidated the cached index; the rescan subtracts
    // the tracked-but-deleted path instead of offering it again.
    expect(
      (await listProjectDirectory(project)).map((entry) => entry.name),
    ).toEqual(["kept.txt"]);
  });
});
