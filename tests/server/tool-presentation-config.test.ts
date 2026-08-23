import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultToolPresentationConfigPath,
  ToolPresentationConfigStore,
} from "../../server/tool-presentation-config.js";

const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  path: string;
  store: ToolPresentationConfigStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "inspire-tool-presentations-"));
  roots.push(root);
  const path = join(root, "tool-presentations.json");
  return { root, path, store: new ToolPresentationConfigStore(path) };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ToolPresentationConfigStore", () => {
  it("treats a missing private file as an empty user layer", async () => {
    const { store } = await fixture();
    await expect(store.inspect()).resolves.toEqual({
      configuration: { version: 1, rules: {}, mappings: {} },
    });
  });

  it("loads one validated declarative rule and exact-name mapping", async () => {
    const { path, store } = await fixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        rules: {
          "user.example.search": {
            summary: [{ value: { path: "args.query" } }],
            blocks: [
              {
                type: "markdown",
                label: "Result",
                source: { path: "result.text" },
              },
            ],
          },
        },
        mappings: { web_search: "user.example.search" },
      }),
    );

    const inspected = await store.inspect();
    expect(inspected.warning).toBeUndefined();
    expect(inspected.configuration.mappings).toEqual({
      web_search: "user.example.search",
    });
    expect(inspected.configuration.rules).toHaveProperty("user.example.search");
  });

  it("loads an optional Thinking summary and structured body declaration", async () => {
    const { path, store } = await fixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        rules: {},
        mappings: {},
        thinking: {
          summary: [
            {
              value: { path: "thinking.text", format: "first-line" },
            },
          ],
          blocks: [
            {
              type: "markdown",
              label: "Reasoning",
              source: { path: "thinking.text" },
            },
          ],
        },
      }),
    );

    const inspected = await store.inspect();
    expect(inspected.warning).toBeUndefined();
    expect(inspected.configuration.thinking).toMatchObject({
      summary: [{ value: { path: "thinking.text", format: "first-line" } }],
      blocks: [{ type: "markdown", label: "Reasoning" }],
    });
  });

  it("reports invalid private input and leaves only shipped rules active", async () => {
    const { path, store } = await fixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        rules: {
          "inspire.pi.read": {
            summary: [{ value: { literal: "replacement" } }],
            blocks: [],
          },
        },
        mappings: { read: "inspire.pi.read" },
      }),
    );

    const inspected = await store.inspect();
    expect(inspected.configuration).toEqual({
      version: 1,
      rules: {},
      mappings: {},
    });
    expect(inspected.warning).toMatch(/invalid key.*Built-in presentations/i);
  });

  it("uses the ignored checkout directory when the installation is a git source", async () => {
    const { root } = await fixture();
    await mkdir(join(root, ".git"));
    expect(defaultToolPresentationConfigPath(root)).toBe(
      join(root, ".inspire", "tool-presentations.json"),
    );
  });
});
