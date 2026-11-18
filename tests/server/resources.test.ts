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
  openAuthorizedResourceFile,
  ResourceStore,
} from "../../server/resources.js";
import type { ResourceDescriptor } from "../../shared/contracts.js";
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

function scope(cwd: string, revision = 1, viewId = "view-s1") {
  return { sessionId: "s1", cwd, revision, viewId };
}

function context(
  cwd: string,
  messages: unknown[] = [],
  revision = 1,
  viewId = "view-s1",
) {
  return { ...scope(cwd, revision, viewId), messages };
}

function citation(text: string, role = "assistant") {
  return { role, content: [{ type: "text", text }] };
}

function resourceByDescriptor({ id, sessionId, viewId }: ResourceDescriptor) {
  const resource = resources.get(id, sessionId, viewId);
  if (resource.authority === "embedded") throw new Error("Expected a file");
  return resource;
}

async function readResource(descriptor: ResourceDescriptor) {
  const { handle } = await resources.openForServing(
    resourceByDescriptor(descriptor),
  );
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
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
  it("keeps the newest ordered citation index when an older transcript finishes late", async () => {
    const { project } = await workspace();
    const older = Promise.withResolvers<unknown[]>();
    const loadOlder = vi.fn(() => older.promise);
    const current = {
      ...scope(project, 8),
      loadMessages: vi.fn(async () => [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "edit",
              name: "edit",
              arguments: { path: "analysis.m" },
            },
          ],
        },
        ...Array.from({ length: 101 }, (_, index) =>
          citation(`See \`file-${index}.md\`.`),
        ),
      ]),
    };
    const pending = resources.list({
      ...current,
      revision: 7,
      loadMessages: loadOlder,
    });
    const listed = await resources.list(current);
    expect(listed).toHaveLength(101);
    expect(listed[0]?.reference).toBe("file-100.md");
    expect(listed.at(-1)).toMatchObject({
      reference: "analysis.m",
      writes: true,
    });
    older.resolve([citation("See \`older.md\`.")]);
    await expect(pending).resolves.toMatchObject([{ reference: "older.md" }]);
    await resources.probe(current, ["file-19.md", "file-0.md"]);
    await expect(resources.list(current)).resolves.toEqual(listed);
    expect(current.loadMessages).toHaveBeenCalledOnce();
    expect(loadOlder).toHaveBeenCalledOnce();
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
    const source = context(project, [citation("[Report](reports/README.md)")]);
    await expect(
      resources.resolve(source, "reports/README.md"),
    ).resolves.toMatchObject({ kind: "markdown" });
    await expect(
      resources.resolve(source, "./reports/curve.png"),
    ).resolves.toMatchObject({
      workspacePath: "reports/curve.png",
      kind: "image",
    });
    await expect(
      resources.resolve(source, "./reports/../node_modules/hidden.png"),
    ).resolves.toMatchObject({
      workspacePath: "node_modules/hidden.png",
      kind: "image",
    });
    await expect(
      resources.resolve(source, "./reports/../../outside.png"),
    ).rejects.toMatchObject({ status: 403 });
    for (const reference of ["./reports/missing.png", "./missing.png"])
      await expect(resources.resolve(source, reference)).rejects.toMatchObject({
        status: 404,
      });
  });

  it("classifies supported source and document families without treating binary lookalikes as text", async () => {
    const { project } = await workspace();
    const source = context(project);
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
        resources.resolve(source, name),
        name,
      ).resolves.toMatchObject({ name, kind });
    }
  });

  it("probes exact workspace files without a transcript and shares one lazy load for citations", async () => {
    const { project } = await workspace();
    await mkdir(join(project, "node_modules"));
    await writeFile(join(project, "visible.md"), "visible");
    await writeFile(join(project, "node_modules/hidden.md"), "hidden");
    const current = scope(project);
    const unavailable = vi.fn(async () => {
      throw new Error("Transcript unavailable");
    });
    await expect(
      resources.resolve(
        { ...current, loadMessages: unavailable },
        "visible.md",
      ),
    ).resolves.toMatchObject({ workspacePath: "visible.md" });
    expect(unavailable).not.toHaveBeenCalled();

    const loadMessages = vi.fn(async () => [citation("See \`missing.md\`.")]);
    const references = [
      "visible.md",
      "missing.md",
      "node_modules/hidden.md",
      "../outside-a.md",
      "../outside-b.md",
      "file://%",
      "node_modules",
    ];
    await expect(
      resources.probe({ ...current, loadMessages }, references),
    ).resolves.toEqual([
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
      ...references.slice(3, 5).map((reference) => ({
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
      {
        reference: "node_modules",
        availability: "invalid",
        message: "The reference is not a file",
      },
    ]);
    expect(loadMessages).toHaveBeenCalledOnce();
  });

  it("authorizes a complete spaced diagnostic path, never its existing sibling prefix", async () => {
    const { root, project } = await workspace();
    const outside = join(root, "Jane Doe", "report.m");
    const wrongPrefix = join(root, "Jane");
    await mkdir(join(root, "Jane Doe"));
    await writeFile(outside, "correct report\n");
    await writeFile(wrongPrefix, "not cited\n");
    const source = context(project, [
      citation(`${outside}:12:3: error: fixture`, "toolResult"),
    ]);
    const listed = await resources.list(source);
    expect(listed.map((item) => item.reference)).toEqual([
      diagnosticResourceReference(outside + ":12:3"),
    ]);
    await expect(resources.resolve(source, outside)).resolves.toMatchObject({
      name: "report.m",
      kind: "text",
    });
    await expect(resources.resolve(source, wrongPrefix)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("reads the current bytes of an embedded reference and rejects invalid or removed blocks", async () => {
    const { project } = await workspace();
    const reference = "pi-embedded://3/0";
    const embedded = (data: string, mimeType: string) => ({
      role: "toolResult",
      __inspireMessageIndex: 3,
      content: [{ type: "image", data, mimeType }],
    });
    const image = (text: string) => Buffer.from(text).toString("base64");
    const descriptor = await resources.resolve(
      context(project, [embedded(image("old-image"), "image/png")]),
      reference,
    );
    const resource = resources.get(
      descriptor.id,
      descriptor.sessionId,
      descriptor.viewId,
    );
    await expect(
      resources.embeddedContent(
        resource,
        context(
          project,
          [citation("replacement"), embedded(image("new-image"), "image/jpeg")],
          2,
        ),
      ),
    ).resolves.toEqual({
      data: Buffer.from("new-image"),
      mimeType: "image/jpeg",
    });
    const invalid = [
      [],
      [embedded("not base64!", "image/png")],
      [embedded("", "image/png")],
      [embedded(image("html"), "text/html")],
    ];
    for (const [offset, messages] of invalid.entries()) {
      const current = context(project, messages, 3 + offset);
      await expect(resources.resolve(current, reference)).rejects.toMatchObject(
        { status: 404 },
      );
      await expect(
        resources.embeddedContent(resource, current),
      ).rejects.toMatchObject({ status: 404 });
    }
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
        openAuthorizedResourceFile(authorizedPath, authorizedPath),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it.runIf(process.platform !== "win32")(
    "admits inside and cited symlinks, then refuses a different target at use",
    async () => {
      const { root, project } = await workspace();
      const inside = join(project, "inside.txt");
      const outside = join(root, "outside.txt");
      const link = join(project, "link.txt");
      await writeFile(inside, "inside");
      await writeFile(outside, "outside");
      await symlink(inside, link);
      const source = context(project);
      const initial = await resources.resolve(source, "link.txt");
      expect(initial.workspacePath).toBe("inside.txt");
      expect(await readResource(initial)).toBe("inside");

      await unlink(link);
      await symlink(outside, link);
      await expect(readResource(initial)).rejects.toMatchObject({
        status: 409,
      });
      await expect(resources.resolve(source, "link.txt")).rejects.toMatchObject(
        { status: 403 },
      );
      const cited = context(project, [citation("[linked](link.txt)")], 2);
      const descriptor = await resources.resolve(cited, "link.txt");
      expect(await readResource(descriptor)).toBe("outside");
      await unlink(link);
      await symlink(inside, link);
      await expect(
        resources.authorize(descriptor.id, cited),
      ).resolves.toMatchObject({ descriptor });
      await expect(readResource(descriptor)).rejects.toMatchObject({
        status: 409,
      });

      // A formerly regular logical path cannot become a link to the outside either.
      const regular = await resources.resolve(source, "inside.txt");
      await unlink(inside);
      await symlink(outside, inside);
      await expect(readResource(regular)).rejects.toMatchObject({
        status: 409,
      });
    },
  );

  it("proves basename uniqueness only with complete discovery and retires deleted entries", async () => {
    const { project } = await workspace();
    await mkdir(join(project, "src"));
    await mkdir(join(project, "other"));
    const source = context(project, [citation("Use \`kernel.py\`.")]);
    const selected = "src/kernel.py";
    const path = join(project, selected);
    await writeFile(path, "kernel");
    const discover = vi.spyOn(projectFiles, "workspaceBasenameMatches");
    discover.mockResolvedValueOnce({ matches: [selected], truncated: true });
    await expect(resources.resolve(source, "kernel.py")).rejects.toMatchObject({
      status: 409,
      matches: [selected],
    });
    expect(discover).toHaveBeenCalledWith(project, "kernel.py");
    discover.mockClear();
    await expect(resources.resolve(source, selected)).resolves.toMatchObject({
      workspacePath: selected,
    });
    for (const [reference, exact] of [
      ["docs/kernel.py", undefined],
      ["kernel.py", "kernel.py"],
    ])
      await expect(
        resources.resolve(source, reference!, exact),
      ).rejects.toMatchObject({ status: 404 });
    expect(discover).not.toHaveBeenCalled();

    const descriptor = await resources.resolve(source, "kernel.py");
    expect(descriptor).toMatchObject({
      name: "kernel.py",
      reference: selected,
      workspacePath: selected,
    });
    expect(await readResource(descriptor)).toBe("kernel");
    const duplicate = "other/kernel.py";
    await writeFile(join(project, duplicate), "duplicate");
    projectFiles.invalidateProjectFiles();
    await expect(resources.resolve(source, "kernel.py")).rejects.toMatchObject({
      status: 409,
      matches: expect.arrayContaining([selected, duplicate]),
    });
    await unlink(path);
    await expect(readResource(descriptor)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      projectFiles.workspaceBasenameMatches(project, "kernel.py"),
    ).resolves.toMatchObject({ matches: [duplicate] });

    const recovered = await resources.resolve(source, "kernel.py");
    expect(recovered.workspacePath).toBe(duplicate);
    await unlink(join(project, duplicate));
    await expect(resources.resolve(source, "kernel.py")).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      projectFiles.workspaceBasenameMatches(project, "kernel.py"),
    ).resolves.toMatchObject({ matches: [] });
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
    const source = context(project);

    for (const name of names) {
      const descriptor = await resources.resolve(source, name, name);
      expect(descriptor).toMatchObject({
        reference: name,
        workspacePath: name,
        name,
      });
      expect(resourceByDescriptor(descriptor).path).toBe(join(project, name));
    }
    const selected = "literal#L9";
    await writeFile(join(project, "literal"), "different file");
    const descriptor = await resources.resolve(source, selected, selected);
    await writeFile(join(project, ".gitignore"), `${selected}\n`);
    projectFiles.invalidateProjectFiles();
    await resources.authorize(descriptor.id, source);
    expect(await readResource(descriptor)).toBe(`${selected}\n`);
  });
});

describe("literal native paths and URL reference identity", () => {
  function toolPath(path: string) {
    return {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path } }],
    };
  }

  function urlLink(url: string) {
    return citation(`[URL target](<${url}>)`);
  }

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
      const descriptor = await resources.resolve(source, list[0]!.reference!);
      expect(descriptor.name).toBe("Program(12).cs");
      expect(descriptor.workspacePath).toBe(
        scope === "inside" ? "C#/Program(12).cs" : undefined,
      );
      expect(await readResource(descriptor)).toBe(
        "NATIVE_HASH_AND_PARENTHESES",
      );
    },
  );

  it("keeps native and URL citations distinct through probes, relative resolution and changes of view", async () => {
    const { root, project } = await workspace();
    const directory = join(root, "C#");
    await mkdir(directory);
    const literal = join(directory, "report%20draft.md");
    const decoded = join(directory, "report draft.md");
    const figure = join(directory, "figure%20draft.svg");
    await writeFile(literal, "LITERAL");
    await writeFile(decoded, "URL");
    await writeFile(figure, "<svg/>");
    const urlTarget = pathToFileURL(decoded).href;
    const literalCitation = toolPath(literal);
    const nativeOnly = context(project, [literalCitation, toolPath(urlTarget)]);
    const listed = await resources.list(nativeOnly);
    const native = listed.find(({ label }) => label === literal)!.reference!;
    expect(listed.find(({ label }) => label === urlTarget)?.reference).toMatch(
      /^file%3A/u,
    );
    await expect(
      resources.probe(nativeOnly, [native, urlTarget]),
    ).resolves.toMatchObject([
      { availability: "available" },
      { availability: "unavailable" },
    ]);
    await expect(
      resources.resolve(nativeOnly, urlTarget),
    ).rejects.toMatchObject({ status: 403 });

    const citedUrl = urlLink(urlTarget);
    const before = context(
      project,
      [literalCitation, citedUrl, toolPath(figure)],
      2,
    );
    const descriptor = await resources.resolve(before, native);
    const urlDescriptor = await resources.resolve(before, urlTarget);
    expect(descriptor.name).toBe("report%20draft.md");
    expect(urlDescriptor.name).toBe("report draft.md");
    expect(await readResource(descriptor)).toBe("LITERAL");
    expect(await readResource(urlDescriptor)).toBe("URL");
    const relative =
      descriptor.reference.slice(0, descriptor.reference.lastIndexOf("/") + 1) +
      "figure%2520draft.svg";
    expect(relative).toContain("C%23/figure%2520draft.svg");
    expect(await readResource(await resources.resolve(before, relative))).toBe(
      "<svg/>",
    );

    const appended = {
      ...before,
      revision: 3,
      messages: [...before.messages, citation("append")],
    };
    await expect(
      resources.authorize(descriptor.id, appended),
    ).resolves.toMatchObject({ descriptor });
    await expect(
      resources.authorize(descriptor.id, { ...appended, viewId: "view-b" }),
    ).rejects.toMatchObject({ status: 404 });

    const after = context(project, [citedUrl], 4);
    await expect(
      resources.authorize(descriptor.id, after),
    ).rejects.toMatchObject({ status: 403 });
    await expect(resources.resolve(after, native)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      resources.authorize(urlDescriptor.id, after),
    ).resolves.toMatchObject({ descriptor: urlDescriptor });
  });
});
