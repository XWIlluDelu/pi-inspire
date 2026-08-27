import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listProjectDirectory } from "../../server/project-files.js";
import {
  openCanonicalResourceFile,
  ResourceStore,
  referencePath,
} from "../../server/resources.js";

const temporaryDirectories: string[] = [];
let resources = new ResourceStore();

async function workspace() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-resources-")),
  );
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

  it("classifies common source and extensionless project files as text", async () => {
    const { project } = await workspace();
    const names = [
      "query.sql",
      "Main.java",
      "task.rb",
      "index.php",
      "Panel.vue",
      "Widget.svelte",
      "Dockerfile",
      "Makefile",
      "LICENSE",
      ".env.local",
    ];
    await Promise.all(
      names.map((name) => writeFile(join(project, name), "plain source\n")),
    );

    for (const name of names) {
      const descriptor = await resources.resolve(
        {
          ...resourceIdentity(),
          cwd: project,
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: `[file](${name})` }],
            },
          ],
        },
        name,
      );
      expect(descriptor.kind, name).toBe("text");
    }
  });

  it("classifies Jupyter notebooks as renderable documents", async () => {
    const { project } = await workspace();
    await writeFile(
      join(project, "analysis.ipynb"),
      JSON.stringify({ cells: [], metadata: {}, nbformat: 4 }),
    );

    const descriptor = await resources.resolve(
      { ...resourceIdentity(), cwd: project, messages: [] },
      "analysis.ipynb",
    );

    expect(descriptor).toMatchObject({
      name: "analysis.ipynb",
      mimeType: "application/x-ipynb+json",
      kind: "notebook",
    });
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
    const report = join(project, "report.md");
    await writeFile(report, "# Result\n");
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
    expect(await opened.handle.readFile("utf8")).toBe("# Result\n");
    await opened.handle.close();

    // A legitimate rewrite retains the authorized filesystem object. Serving
    // opens a fresh handle, so it reports current bytes rather than stale
    // resolve-time metadata.
    await writeFile(report, "# Rewritten in place\n");
    const rewritten = await resources.openForServing(resource);
    expect(await rewritten.handle.readFile("utf8")).toBe(
      "# Rewritten in place\n",
    );
    await rewritten.handle.close();

    await rm(report);
    if (process.platform !== "win32") {
      // Swapping the file for a symlink to an outside secret is rejected before
      // following the link.
      await symlink(join(root, "secret.txt"), report);
      await expect(resources.openForServing(resource)).rejects.toMatchObject({
        status: 409,
      });
      await rm(report);
    }

    // Same-path regeneration would otherwise be able to reuse an inode on some
    // filesystems. The retained anchor keeps the original inode live, so the
    // stale handle must be re-resolved rather than serving new bytes.
    await writeFile(report, "# Regenerated\n");
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
    const content = await resources.embeddedContent(resolved, {
      ...resourceIdentity(),
      cwd: project,
      messages,
    });
    expect(content.data.toString()).toBe("image-bytes");
    expect(content.mimeType).toBe("image/png");
  });

  it("rejects malformed or non-image embedded blocks", async () => {
    const { project } = await workspace();
    for (const data of ["not base64!", ""]) {
      const invalidData = [
        {
          role: "toolResult",
          content: [{ type: "image", data, mimeType: "image/png" }],
        },
      ];
      await expect(
        resources.resolve(
          { ...resourceIdentity(), cwd: project, messages: invalidData },
          "pi-embedded://0/0",
        ),
      ).rejects.toMatchObject({ status: 404 });
    }

    const invalidType = [
      {
        role: "toolResult",
        content: [
          {
            type: "image",
            data: Buffer.from("html").toString("base64"),
            mimeType: "text/html",
          },
        ],
      },
    ];
    await expect(
      resources.resolve(
        { ...resourceIdentity(), cwd: project, messages: invalidType },
        "pi-embedded://0/0",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("revalidates embedded handles against the current projection before serving", async () => {
    const { project } = await workspace();
    const original = [
      {
        role: "toolResult",
        __inspireMessageIndex: 3,
        content: [
          { type: "image", data: "b2xkLWltYWdl", mimeType: "image/png" },
        ],
      },
    ];
    const descriptor = await resources.resolve(
      { ...resourceIdentity("view-s1", 1), cwd: project, messages: original },
      "pi-embedded://3/0",
    );
    const resolved = resources.get(descriptor.id, "s1", "view-s1");
    const rewritten = [
      { role: "assistant", content: [{ type: "text", text: "replacement" }] },
      {
        role: "toolResult",
        __inspireMessageIndex: 3,
        content: [
          { type: "image", data: "bmV3LWltYWdl", mimeType: "image/jpeg" },
        ],
      },
    ];

    const rewrittenContent = await resources.embeddedContent(resolved, {
      ...resourceIdentity("view-s1", 2),
      cwd: project,
      messages: rewritten,
    });
    expect(rewrittenContent.data.toString()).toBe("new-image");
    expect(rewrittenContent.mimeType).toBe("image/jpeg");
    await expect(
      resources.embeddedContent(resolved, {
        ...resourceIdentity("view-s1", 3),
        cwd: project,
        messages: [],
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it.runIf(process.platform !== "win32")(
    "rejects an ancestor exchange between canonical authorization and descriptor open",
    async () => {
      const { root, project } = await workspace();
      const nested = join(project, "nested");
      const parked = join(project, "nested-safe");
      const outside = join(root, "outside");
      await mkdir(nested);
      await mkdir(outside);
      await writeFile(join(nested, "value.txt"), "safe");
      await writeFile(join(outside, "value.txt"), "outside");
      const authorizedPath = await realpath(join(nested, "value.txt"));

      await rename(nested, parked);
      await symlink(outside, nested, "dir");

      await expect(
        openCanonicalResourceFile(authorizedPath),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it.runIf(process.platform !== "win32")(
    "binds a cited symlink to the target authorized at resolve time",
    async () => {
      const { root, project } = await workspace();
      await mkdir(join(project, "node_modules"));
      const first = join(root, "first.txt");
      const second = join(root, "second.txt");
      const selected = join(project, "node_modules", "linked.txt");
      await writeFile(first, "first");
      await writeFile(second, "second");
      await symlink(first, selected);
      const citation = {
        role: "assistant",
        content: "[linked](node_modules/linked.txt)",
      };
      const context = {
        ...resourceIdentity(),
        cwd: project,
        messages: [citation],
      };
      const descriptor = await resources.resolve(
        context,
        "node_modules/linked.txt",
      );
      const resource = resources.get(descriptor.id, "s1", descriptor.viewId);

      await unlink(selected);
      await symlink(second, selected);

      await expect(
        resources.revalidate(resource, context),
      ).resolves.toBeUndefined();
      await expect(resources.openForServing(resource)).rejects.toMatchObject({
        status: 409,
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not treat a project symlink as authority for an outside file",
    async () => {
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
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a git-indexed symlink inside the workspace boundary",
    async () => {
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
    },
  );

  it("revokes cached index authority before serving newly ignored content", async () => {
    const { project } = await workspace();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["-C", project, "init", "-q"]);
    await writeFile(join(project, "draft.txt"), "draft\n");
    const context = { ...resourceIdentity(), cwd: project, messages: [] };
    const descriptor = await resources.resolve(context, "draft.txt");
    const resource = resources.get(descriptor.id, "s1", descriptor.viewId);

    await writeFile(join(project, ".gitignore"), "draft.txt\n");

    await expect(resources.revalidate(resource, context)).rejects.toMatchObject(
      {
        status: 403,
      },
    );
  });

  it("retains an explicit citation after workspace index authority is removed", async () => {
    const { project } = await workspace();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["-C", project, "init", "-q"]);
    await writeFile(join(project, "draft.txt"), "draft\n");
    const context = {
      ...resourceIdentity(),
      cwd: project,
      messages: [{ role: "assistant", content: "[draft](draft.txt)" }],
    };
    const descriptor = await resources.resolve(context, "draft.txt");
    const resource = resources.get(descriptor.id, "s1", descriptor.viewId);

    await writeFile(join(project, ".gitignore"), "draft.txt\n");

    await expect(
      resources.revalidate(resource, context),
    ).resolves.toBeUndefined();
  });

  it("does not let an indexed symlink promote an ignored in-workspace target", async () => {
    const { project } = await workspace();
    await writeFile(join(project, ".gitignore"), "secret.txt\n");
    await writeFile(join(project, "secret.txt"), "secret\n");
    await symlink("secret.txt", join(project, "linked.txt"));
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["-C", project, "init", "-q"]);
    await promisify(execFile)("git", [
      "-C",
      project,
      "add",
      ".gitignore",
      "linked.txt",
    ]);

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
      reference: "src/kernel.py",
    });
    expect(resources.get(descriptor.id, "s1", descriptor.viewId).path).toBe(
      join(project, "src", "kernel.py"),
    );
  });

  it("treats a workspace selection as an exact indexed path", async () => {
    const { project } = await workspace();
    const names = [
      "@literal",
      "literal#L9",
      "%66oo.txt",
      ...(process.platform === "win32" ? [] : ["literal:12", "literal?draft"]),
    ];
    await Promise.all(
      names.map((name) => writeFile(join(project, name), `${name}\n`)),
    );
    const context = { ...resourceIdentity(), cwd: project, messages: [] };

    for (const name of names) {
      const descriptor = await resources.resolve(context, name, true, name);
      expect(descriptor).toMatchObject({
        reference: name,
        workspacePath: name,
        name,
      });
      expect(resources.get(descriptor.id, "s1", descriptor.viewId).path).toBe(
        join(project, name),
      );
    }
  });

  it("does not reinterpret an exact workspace name as citation syntax", async () => {
    const { project } = await workspace();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = (...args: string[]) =>
      promisify(execFile)("git", ["-C", project, ...args]);
    await git("init", "-q");
    await writeFile(join(project, "secret"), "other\n");
    await writeFile(join(project, "secret#L12"), "selected\n");
    const context = {
      ...resourceIdentity(),
      cwd: project,
      messages: [{ role: "assistant", content: "[different file](secret)" }],
    };
    const descriptor = await resources.resolve(
      context,
      "secret#L12",
      true,
      "secret#L12",
    );
    const resource = resources.get(descriptor.id, "s1", descriptor.viewId);

    await writeFile(join(project, ".gitignore"), "secret#L12\n");

    await expect(resources.revalidate(resource, context)).rejects.toMatchObject(
      { status: 403 },
    );
  });

  it("does not recover another basename for a missing exact workspace path", async () => {
    const { project } = await workspace();
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "kernel.py"), "print('k')\n");

    await expect(
      resources.resolve(
        { ...resourceIdentity(), cwd: project, messages: [] },
        "kernel.py",
        true,
        "kernel.py",
      ),
    ).rejects.toMatchObject({ status: 403 });
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
      matches: expect.arrayContaining(["a/notes.md", "b/notes.md"]),
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
