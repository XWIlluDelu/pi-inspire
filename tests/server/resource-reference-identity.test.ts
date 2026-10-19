import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ResourceContext, ResourceStore } from "../../server/resources.js";

let root: string;
let cwd: string;
let store: ResourceStore;

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-reference-identity-")),
  );
  cwd = join(root, "workspace");
  await mkdir(cwd);
  store = new ResourceStore();
});
afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

function context(messages: unknown[], revision = 1): ResourceContext {
  return {
    sessionId: "identity",
    viewId: "identity-view",
    revision,
    cwd,
    messages,
  };
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
    content: [{ type: "text", text: "[URL target](" + url + ")" }],
  };
}
async function bytes(id: string) {
  const resource = store.get(id, "identity", "identity-view");
  const opened = await store.openForServing(resource);
  try {
    return await opened.handle.readFile("utf8");
  } finally {
    await opened.handle.close();
  }
}

describe("literal native paths and URL reference identity", () => {
  it("opens the literal-percent file and does not authorize its uncited decoded sibling", async () => {
    const literal = join(root, "report%20draft.md");
    const decoded = join(root, "report draft.md");
    await writeFile(literal, "ONLY_CITED_LITERAL");
    await writeFile(decoded, "UNRELATED_DECODED_FILE");
    const source = context([toolPath(literal)]);
    const list = await store.list(source);
    expect(list.resources).toHaveLength(1);
    expect(list.resources[0]!.label).toBe(literal);
    const reference = list.resources[0]!.reference!;
    expect(reference).toContain("report%2520draft.md");
    const descriptor = await store.resolve(source, reference);
    expect(descriptor.name).toBe("report%20draft.md");
    expect(descriptor.workspacePath).toBeUndefined();
    expect(await bytes(descriptor.id)).toBe("ONLY_CITED_LITERAL");
    await expect(
      store.resolve(source, pathToFileURL(decoded).href),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      store.probe(source, [reference, pathToFileURL(decoded).href]),
    ).resolves.toMatchObject([
      { reference, availability: "available" },
      { reference: pathToFileURL(decoded).href, availability: "unavailable" },
    ]);
  });

  it("does not give a URL-looking literal tool path authority over an external URI target", async () => {
    const outside = join(root, "external.md");
    await writeFile(outside, "UNCITED_URI_TARGET");
    const url = pathToFileURL(outside).href;
    const source = context([toolPath(url)]);
    const list = await store.list(source);
    expect(list.resources).toHaveLength(1);
    expect(list.resources[0]!.reference).toMatch(/^file%3A/u);
    expect(list.resources[0]!.label).toBe(url);
    await expect(store.resolve(source, url)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("keeps native and file-URL citations independent when both files exist", async () => {
    const literal = join(root, "report%20draft.md");
    const decoded = join(root, "report draft.md");
    await writeFile(literal, "LITERAL");
    await writeFile(decoded, "URL");
    const source = context([
      toolPath(literal),
      urlLink(pathToFileURL(decoded).href),
    ]);
    const list = await store.list(source);
    expect(list.resources).toHaveLength(2);
    expect(new Set(list.resources.map(({ key }) => key)).size).toBe(2);
    for (const entry of list.resources) {
      const descriptor = await store.resolve(source, entry.reference!);
      expect(await bytes(descriptor.id)).toBe(
        entry.source === "tool" ? "LITERAL" : "URL",
      );
      expect(descriptor.name).toBe(
        entry.source === "tool" ? "report%20draft.md" : "report draft.md",
      );
    }
  });

  it.each(["inside", "outside"] as const)(
    "preserves a hash directory and a location-shaped native basename %s the workspace",
    async (scope) => {
      const directory = join(scope === "inside" ? cwd : root, "C#");
      await mkdir(directory);
      const path = join(directory, "Program(12).cs");
      await writeFile(path, "NATIVE_HASH_AND_PARENTHESES");
      const source = context([toolPath(path)]);
      const list = await store.list(source);
      const descriptor = await store.resolve(
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
    const directory = join(root, "C#");
    await mkdir(directory);
    const document = join(directory, "report%20draft.md");
    const figure = join(directory, "figure%20draft.svg");
    await writeFile(document, "# Literal document");
    await writeFile(figure, "<svg/>");
    const source = context([toolPath(document), toolPath(figure)]);
    const listed = await store.list(source);
    const entry = listed.resources.find(({ label }) => label === document)!;
    const descriptor = await store.resolve(source, entry.reference!);
    // The returned metadata is URL-joinable on either Host platform; the
    // browser need not reinterpret native separators or decode the directory.
    const reference =
      descriptor.reference.slice(0, descriptor.reference.lastIndexOf("/") + 1) +
      "figure%2520draft.svg";
    expect(reference).toContain("C%23/");
    expect(reference).toContain("figure%2520draft.svg");
    const resolved = await store.resolve(source, reference!);
    expect(resolved.name).toBe("figure%20draft.svg");
    expect(await bytes(resolved.id)).toBe("<svg/>");
  });

  it("retains only the cited representation's authority after a compatible transcript revision", async () => {
    const literal = join(root, "report%20draft.md");
    const decoded = join(root, "report draft.md");
    await writeFile(literal, "LITERAL");
    await writeFile(decoded, "URL");
    const before = context([
      toolPath(literal),
      urlLink(pathToFileURL(decoded).href),
    ]);
    const list = await store.list(before);
    const native = list.resources.find(({ source }) => source === "tool")!;
    const url = list.resources.find(({ source }) => source === "link")!;
    const nativeDescriptor = await store.resolve(before, native.reference!);
    const urlDescriptor = await store.resolve(before, url.reference!);
    const after = context([urlLink(pathToFileURL(decoded).href)], 2);
    await expect(
      store.revalidate(
        store.get(nativeDescriptor.id, "identity", "identity-view"),
        after,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      store.revalidate(
        store.get(urlDescriptor.id, "identity", "identity-view"),
        after,
      ),
    ).resolves.toBeUndefined();
    await expect(store.resolve(after, native.reference!)).rejects.toMatchObject(
      { status: 403 },
    );
  });
});
