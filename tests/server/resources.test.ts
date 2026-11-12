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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as projectFiles from "../../server/project-files.js";
import {
  invalidateProjectFiles,
  workspaceBasenameMatches,
} from "../../server/project-files.js";
import {
  openCanonicalResourceFile,
  type ResourceContext,
  ResourceStore,
  referencePath,
} from "../../server/resources.js";
import { diagnosticResourceReference } from "../../shared/resource-references.js";

const temporaryDirectories: string[] = [];
let resources: ResourceStore;

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

beforeEach(() => {
  resources = new ResourceStore();
});
afterEach(async () => {
  await resources.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ResourceStore", () => {
  it("lists the newest references and every written file from one citation index", async () => {
    const { project } = await workspace();
    let messageLoads = 0;
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "edit-1",
            name: "edit",
            arguments: { path: "analysis.m" },
          },
        ],
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        role: "assistant",
        content: [{ type: "text", text: `See \`file-${index}.md\`.` }],
      })),
    ];
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

    const listed = await resources.list(context);
    expect(listed.resources).toHaveLength(21);
    expect(listed.resources[0]?.reference).toBe("file-19.md");
    expect(listed.produced).toEqual([
      expect.objectContaining({ reference: "analysis.m", writes: true }),
    ]);

    await resources.probe(context, ["file-19.md", "file-0.md"]);
    expect(messageLoads).toBe(1);
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
    await expect(newerList).resolves.toMatchObject({
      resources: [{ reference: "newer.md" }],
    });
    resolveOlder([
      {
        role: "assistant",
        content: [{ type: "text", text: "See `older.md`." }],
      },
    ]);
    await expect(olderList).resolves.toMatchObject({
      resources: [{ reference: "older.md" }],
    });

    await expect(resources.list(newerContext)).resolves.toMatchObject({
      resources: [{ reference: "newer.md" }],
    });
    expect({ olderLoads, newerLoads }).toEqual({
      olderLoads: 1,
      newerLoads: 1,
    });
  });

  it("authorizes document images independently without following arbitrary document citations or recovering a different basename", async () => {
    const { root, project } = await workspace();
    await mkdir(join(project, "reports"));
    await mkdir(join(project, "other"));
    await mkdir(join(project, "node_modules"));
    await writeFile(
      join(project, "reports", "README.md"),
      "![Outside](../../outside.png) ![Ignored](../node_modules/hidden.png)",
    );
    await writeFile(join(project, "reports", "curve.png"), "indexed image");
    await writeFile(join(project, "other", "missing.png"), "wrong image");
    await writeFile(
      join(project, "node_modules", "hidden.png"),
      "ignored image",
    );
    await writeFile(join(root, "outside.png"), "outside image");
    const context = {
      ...resourceIdentity(),
      cwd: project,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "[Report](reports/README.md)" }],
        },
      ],
    };
    await expect(
      resources.resolve(context, "reports/README.md"),
    ).resolves.toMatchObject({ kind: "markdown" });
    await expect(
      resources.resolve(context, "./reports/curve.png"),
    ).resolves.toMatchObject({
      workspacePath: "reports/curve.png",
      kind: "image",
    });
    await expect(
      resources.resolve(context, "./reports/../node_modules/hidden.png"),
    ).resolves.toMatchObject({
      workspacePath: "node_modules/hidden.png",
      kind: "image",
    });
    await expect(
      resources.resolve(context, "./reports/../../outside.png"),
    ).rejects.toMatchObject({ status: 403 });
    for (const reference of ["./reports/missing.png", "./missing.png"])
      await expect(resources.resolve(context, reference)).rejects.toMatchObject(
        { status: 404 },
      );
  });

  it("opens native VS Code file URIs with escaped spaces and line/column suffixes", async () => {
    const { project } = await workspace();
    const file = join(project, "my report.md");
    await writeFile(file, "report");
    const reference =
      pathToFileURL(file).href.replace(/^file:\/\//, "vscode://file") + ":5:10";
    expect(referencePath(reference, project)).toBe(file);
    expect(referencePath(reference.replace(":5:10", "#L5"), project)).toBe(
      file,
    );
    await expect(
      resources.resolve(
        { ...resourceIdentity(), cwd: project, messages: [] },
        reference,
      ),
    ).resolves.toMatchObject({ name: "my report.md" });
  });

  it("classifies supported source and document families without treating binary lookalikes as text", async () => {
    const { project } = await workspace();
    const context = { ...resourceIdentity(), cwd: project, messages: [] };
    for (const [name, bytes, kind] of [
      ["query.sql", "select 1", "text"],
      ["Dockerfile", "FROM scratch", "text"],
      [".bash_profile", "export NAME=fixture", "text"],
      ["setup.ps1", "Write-Output fixture", "text"],
      ["build.cmd", "echo fixture", "text"],
      ["main.mm", "int main() {}", "text"],
      ["App.csproj", "<Project/>", "text"],
      ["Info.plist", '<?xml version="1.0"?><plist><dict/></plist>', "text"],
      ["Binary.plist", Buffer.from("bplist00\x00\x01"), "binary"],
      ["unknown.bin", Buffer.from([0, 255]), "binary"],
      ["analysis.ipynb", '{"cells":[],"nbformat":4}', "notebook"],
    ] as const) {
      await writeFile(join(project, name), bytes);
      await expect(
        resources.resolve(context, name),
        name,
      ).resolves.toMatchObject({ name, kind });
    }
  });

  it("binds citation handles to one branch view while allowing same-view append revalidation", async () => {
    const { root, project } = await workspace();
    await writeFile(join(root, "branch-only.txt"), "branch A\n");
    const citation = {
      role: "assistant",
      content: [{ type: "text", text: "[branch](../branch-only.txt)" }],
    };
    const contextA = {
      ...resourceIdentity("view-a", 2),
      cwd: project,
      messages: [citation],
    };
    await expect(
      resources.resolve(
        { ...contextA, revision: 1, messages: [] },
        "../branch-only.txt",
      ),
    ).rejects.toMatchObject({ status: 403 });
    const descriptor = await resources.resolve(contextA, "../branch-only.txt");
    const resource = resources.get(descriptor.id, "s1", "view-a");

    await expect(
      resources.revalidate(resource, {
        ...contextA,
        revision: 3,
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
      "../outside-a.md",
      "../outside-b.md",
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
        availability: "available",
        workspacePath: "node_modules/hidden.md",
      },
      ...["../outside-a.md", "../outside-b.md"].map((reference) => ({
        reference,
        availability: "unavailable",
        message:
          "The file is not part of this session's workspace or transcript",
      })),
      {
        reference: "file://%",
        availability: "invalid",
        message: "The file reference is not valid",
      },
    ]);
    expect(messageLoads).toBe(1);
  });

  it("can resolve workspace files while the transcript is unavailable", async () => {
    const { project } = await workspace();
    await writeFile(join(project, "indexed.txt"), "indexed\n");
    await expect(
      resources.resolve(
        {
          ...resourceIdentity(),
          cwd: project,
          loadMessages: async () => {
            throw new Error("Transcript unavailable");
          },
        },
        "indexed.txt",
      ),
    ).resolves.toMatchObject({ workspacePath: "indexed.txt" });
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

  it("authorizes a complete spaced diagnostic path, never its existing sibling prefix", async () => {
    const { root, project } = await workspace();
    const outside = join(root, "Jane Doe", "report.m");
    const wrongPrefix = join(root, "Jane");
    await mkdir(join(root, "Jane Doe"));
    await writeFile(outside, "correct report\n");
    await writeFile(wrongPrefix, "not cited\n");
    const context = {
      ...resourceIdentity(),
      cwd: project,
      messages: [
        {
          role: "toolResult",
          content: [{ type: "text", text: outside + ":12:3: error: fixture" }],
        },
      ],
    };
    const listed = await resources.list(context);
    expect(listed.resources.map((item) => item.reference)).toEqual([
      diagnosticResourceReference(outside + ":12:3"),
    ]);
    await expect(resources.resolve(context, outside)).resolves.toMatchObject({
      name: "report.m",
      kind: "text",
    });
    await expect(resources.resolve(context, wrongPrefix)).rejects.toMatchObject(
      { status: 403 },
    );
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
    "resolves an inside symlink without granting access through an outside symlink",
    async () => {
      const { root, project } = await workspace();
      await writeFile(join(project, "inside.txt"), "inside");
      await writeFile(join(root, "outside.txt"), "outside");
      await symlink("inside.txt", join(project, "internal-link.txt"));
      await symlink("../outside.txt", join(project, "external-link.txt"));
      const context = { ...resourceIdentity(), cwd: project, messages: [] };

      await expect(
        resources.resolve(context, "internal-link.txt"),
      ).resolves.toMatchObject({ workspacePath: "inside.txt" });
      await expect(
        resources.resolve(context, "external-link.txt"),
      ).rejects.toMatchObject({ status: 403 });
    },
  );

  it.each(["resolve", "serve"])(
    "retires a cached basename after a missing file fails to %s",
    async (operation) => {
      const { project } = await workspace();
      const path = join(project, "gone.txt");
      await writeFile(path, "gone");
      const context = { ...resourceIdentity(), cwd: project, messages: [] };
      const descriptor = await resources.resolve(context, "gone.txt");
      const resource = resources.get(descriptor.id, "s1", descriptor.viewId);
      expect(
        (await workspaceBasenameMatches(project, "gone.txt")).matches,
      ).toEqual(["gone.txt"]);
      await unlink(path);
      if (operation === "serve") {
        await resources.revalidate(resource, context);
        await expect(resources.openForServing(resource)).rejects.toMatchObject({
          status: 404,
        });
      } else {
        await expect(
          resources.resolve(context, "gone.txt"),
        ).rejects.toMatchObject({ status: 404 });
      }
      expect(
        (await workspaceBasenameMatches(project, "gone.txt")).matches,
      ).toEqual([]);
    },
  );

  it("refuses to infer uniqueness from incomplete discovery without blocking an exact path", async () => {
    const { project } = await workspace();
    await mkdir(join(project, "docs"));
    await writeFile(join(project, "docs", "report.txt"), "synthetic report");
    // The resolver cares about scan completeness, not why the scanner stopped.
    // Raw non-UTF-8 filenames are covered by the filesystem scanner's own test.
    const discover = vi
      .spyOn(projectFiles, "workspaceBasenameMatches")
      .mockResolvedValue({ matches: ["docs/report.txt"], truncated: true });
    const context = { ...resourceIdentity(), cwd: project, messages: [] };
    await expect(
      resources.resolve(context, "report.txt"),
    ).rejects.toMatchObject({
      status: 409,
      matches: ["docs/report.txt"],
    });
    expect(discover).toHaveBeenCalledWith(project, "report.txt");
    discover.mockClear();
    await expect(
      resources.resolve(context, "docs/report.txt"),
    ).resolves.toMatchObject({
      workspacePath: "docs/report.txt",
    });
    expect(discover).not.toHaveBeenCalled();
  });

  it("recovers only bare mentions and offers candidates when a name becomes ambiguous", async () => {
    const { project } = await workspace();
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "kernel.py"), "print('k')\n");
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "the loop lives in `kernel.py`" }],
      },
    ];

    const context = { ...resourceIdentity(), cwd: project, messages };
    const descriptor = await resources.resolve(context, "kernel.py");
    // The descriptor reports where it actually resolved, never the shorthand.
    expect(descriptor).toMatchObject({
      name: "kernel.py",
      reference: "src/kernel.py",
    });
    expect(resources.get(descriptor.id, "s1", descriptor.viewId).path).toBe(
      join(project, "src", "kernel.py"),
    );
    // An explicit location or a tree selection cannot fall back to basename recovery.
    await expect(
      resources.resolve(context, "docs/kernel.py"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      resources.resolve(context, "kernel.py", "kernel.py"),
    ).rejects.toMatchObject({ status: 404 });

    await mkdir(join(project, "other"));
    await writeFile(join(project, "other", "kernel.py"), "another script");
    invalidateProjectFiles(project);
    await expect(resources.resolve(context, "kernel.py")).rejects.toMatchObject(
      {
        status: 409,
        matches: expect.arrayContaining(["src/kernel.py", "other/kernel.py"]),
      },
    );
  });

  it("treats a workspace selection as an exact filesystem path", async () => {
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
      const descriptor = await resources.resolve(context, name, name);
      expect(descriptor).toMatchObject({
        reference: name,
        workspacePath: name,
        name,
      });
      expect(resources.get(descriptor.id, "s1", descriptor.viewId).path).toBe(
        join(project, name),
      );
    }
    const selected = "literal#L9";
    await writeFile(join(project, "literal"), "different file");
    const descriptor = await resources.resolve(context, selected, selected);
    const resource = resources.get(descriptor.id, "s1", descriptor.viewId);
    await writeFile(join(project, ".gitignore"), `${selected}\n`);
    invalidateProjectFiles(project);
    await resources.revalidate(resource, context);
    const opened = await resources.openForServing(resource);
    try {
      expect(await opened.handle.readFile("utf8")).toBe(`${selected}\n`);
    } finally {
      await opened.handle.close();
    }
  });
});

describe("literal native paths and URL reference identity", () => {
  function context(
    cwd: string,
    messages: unknown[],
    revision = 1,
  ): ResourceContext {
    return { ...resourceIdentity(undefined, revision), cwd, messages };
  }

  function toolPath(path: string) {
    return {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path } }],
    };
  }

  function urlLink(url: string) {
    return {
      role: "assistant",
      content: [{ type: "text", text: `[URL target](<${url}>)` }],
    };
  }

  function resourceById(id: string) {
    const { sessionId, viewId } = resourceIdentity();
    return resources.get(id, sessionId, viewId);
  }

  async function bytes(id: string) {
    const { handle } = await resources.openForServing(resourceById(id));
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  it("does not give a URL-looking literal tool path authority over an external URI target", async () => {
    const { root, project } = await workspace();
    const outside = join(root, "external.md");
    await writeFile(outside, "UNCITED_URI_TARGET");
    const url = pathToFileURL(outside).href;
    const source = context(project, [toolPath(url)]);
    const list = await resources.list(source);
    expect(list.resources).toHaveLength(1);
    expect(list.resources[0]!.reference).toMatch(/^file%3A/u);
    expect(list.resources[0]!.label).toBe(url);
    await expect(resources.resolve(source, url)).rejects.toMatchObject({
      status: 403,
    });
  });

  it.each(["inside", "outside"] as const)(
    "preserves a hash directory and a location-shaped native basename %s the workspace",
    async (scope) => {
      const { root, project } = await workspace();
      const directory = join(scope === "inside" ? project : root, "C#");
      await mkdir(directory);
      const path = join(directory, "Program(12).cs");
      await writeFile(path, "NATIVE_HASH_AND_PARENTHESES");
      const source = context(project, [toolPath(path)]);
      const list = await resources.list(source);
      const descriptor = await resources.resolve(
        source,
        list.resources[0]!.reference!,
      );
      expect(descriptor.name).toBe("Program(12).cs");
      expect(descriptor.workspacePath).toBe(
        scope === "inside" ? "C#/Program(12).cs" : undefined,
      );
      expect(await bytes(descriptor.id)).toBe("NATIVE_HASH_AND_PARENTHESES");
    },
  );

  it("joins a cited external document's URL relative to its literal native directory", async () => {
    const { root, project } = await workspace();
    const directory = join(root, "C#");
    await mkdir(directory);
    const document = join(directory, "report%20draft.md");
    const figure = join(directory, "figure%20draft.svg");
    await writeFile(document, "# Literal document");
    await writeFile(figure, "<svg/>");
    const source = context(project, [toolPath(document), toolPath(figure)]);
    const listed = await resources.list(source);
    const entry = listed.resources.find(({ label }) => label === document)!;
    const descriptor = await resources.resolve(source, entry.reference!);
    // The returned metadata is URL-joinable on either Host platform; the
    // browser need not reinterpret native separators or decode the directory.
    const reference =
      descriptor.reference.slice(0, descriptor.reference.lastIndexOf("/") + 1) +
      "figure%2520draft.svg";
    expect(reference).toContain("C%23/");
    expect(reference).toContain("figure%2520draft.svg");
    const resolved = await resources.resolve(source, reference!);
    expect(resolved.name).toBe("figure%20draft.svg");
    expect(await bytes(resolved.id)).toBe("<svg/>");
  });

  it("serves native and file-URL citations independently across a transcript revision", async () => {
    const { root, project } = await workspace();
    const literal = join(root, "report%20draft.md");
    const decoded = join(root, "report draft.md");
    await writeFile(literal, "LITERAL");
    await writeFile(decoded, "URL");
    const urlTarget = pathToFileURL(decoded).href;
    const nativeOnly = context(project, [toolPath(literal)]);
    const {
      resources: [cited],
    } = await resources.list(nativeOnly);
    expect(
      await resources.probe(nativeOnly, [cited!.reference!, urlTarget]),
    ).toMatchObject([
      { availability: "available" },
      { availability: "unavailable" },
    ]);
    await expect(
      resources.resolve(nativeOnly, urlTarget),
    ).rejects.toMatchObject({
      status: 403,
    });
    const before = context(project, [toolPath(literal), urlLink(urlTarget)], 2);
    const list = await resources.list(before);
    expect(list.resources).toHaveLength(2);
    const native = list.resources.find(({ source }) => source === "tool")!;
    const url = list.resources.find(({ source }) => source === "link")!;
    const nativeDescriptor = await resources.resolve(before, native.reference!);
    const urlDescriptor = await resources.resolve(before, url.reference!);
    expect(nativeDescriptor.name).toBe("report%20draft.md");
    expect(urlDescriptor.name).toBe("report draft.md");
    expect(await bytes(nativeDescriptor.id)).toBe("LITERAL");
    expect(await bytes(urlDescriptor.id)).toBe("URL");

    const after = context(project, [urlLink(urlTarget)], 3);
    await expect(
      resources.revalidate(resourceById(nativeDescriptor.id), after),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      resources.revalidate(resourceById(urlDescriptor.id), after),
    ).resolves.toBeUndefined();
    await expect(
      resources.resolve(after, native.reference!),
    ).rejects.toMatchObject({ status: 403 });
  });
});
