import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  it("composes external adapters beside a symlinked profile and removes disabled contributions", async () => {
    const { root, path, store } = await fixture();
    const profileDirectory = join(root, "profiles");
    await mkdir(profileDirectory);
    await writeFile(
      join(profileDirectory, "module.json"),
      JSON.stringify({
        version: 1,
        rules: {},
        mappings: {},
        hiddenStatuses: ["example-state"],
        controls: [
          {
            id: "user.example.mode",
            slot: "thinking",
            label: "Mode",
            command: "/mode:2",
            state: { key: "example-state", value: "mode" },
            options: [
              { value: "normal", label: "Normal" },
              { value: "quick", label: "Quick" },
            ],
          },
        ],
        checkpoints: [
          {
            source: "example",
            title: "Archived",
            tokensLabel: "Chunk",
            tokensDescription: "Input chunk",
          },
        ],
      }),
    );
    await writeFile(
      join(profileDirectory, "profile.json"),
      JSON.stringify({
        version: 1,
        rules: {},
        mappings: {},
        adapters: [
          { id: "example", name: "Example", path: "./module.json" },
          {
            id: "unavailable",
            name: "Unavailable",
            path: "./missing.json",
            enabled: false,
          },
        ],
      }),
    );
    await symlink(join(profileDirectory, "profile.json"), path);
    const active = await store.inspect();
    expect(active.warning).toBeUndefined();
    expect(active.configuration.hiddenStatuses).toEqual(["example-state"]);
    expect(active.configuration.controls?.[0]?.command).toBe("/mode:2");
    expect(active.configuration.checkpoints?.[0]?.source).toBe("example");
    const disabled = await store.inspect({ example: false });
    expect(disabled.configuration).toEqual({
      version: 1,
      rules: {},
      mappings: {},
    });
    expect(disabled.adapters?.map((adapter) => adapter.enabled)).toEqual([
      false,
      false,
    ]);
    const broken = await store.inspect({ unavailable: true });
    expect(broken.warning).toMatch(/Unavailable/);
    expect(broken.configuration.hiddenStatuses).toEqual(["example-state"]);
  });

  it("reloads custom-message declarations and fails invalid profiles back to the empty user layer", async () => {
    const { path, store } = await fixture();
    const configuration = {
      version: 1,
      rules: {},
      mappings: {},
      customMessages: {
        extension_message: {
          source: "Review",
          title: ["details.sender"],
          body: "details.body",
          requireAbsent: ["details.origin"],
        },
      },
    };
    await writeFile(path, JSON.stringify(configuration));
    expect(await store.inspect()).toEqual({ configuration });
    configuration.customMessages.extension_message.source = "Updated";
    await writeFile(path, JSON.stringify(configuration));
    expect(
      (await store.inspect()).configuration.customMessages?.extension_message
        ?.source,
    ).toBe("Updated");
    configuration.customMessages.extension_message.body =
      "details.__proto__.body";
    await writeFile(path, JSON.stringify(configuration));
    const invalid = await store.inspect();
    expect(invalid.configuration).toEqual({
      version: 1,
      rules: {},
      mappings: {},
    });
    expect(invalid.warning).toMatch(
      /Custom tool presentations were not loaded/,
    );
  });

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
