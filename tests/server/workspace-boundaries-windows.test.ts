import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real Win32 path algorithms + independent in-memory directory identities.
// These are filesystem contracts, not evidence from a native Windows volume.
const io = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
  opendir: vi.fn(),
  readFile: vi.fn(),
  open: vi.fn(),
}));
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, ...actual.win32 };
});
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  ...io,
}));
vi.mock("../../server/pi-runtime.js", () => ({
  getAgentDir: () => "C:\\agent",
}));

import {
  addAttachmentContext,
  resolveProjectFiles,
} from "../../server/attachments.js";
import { HtmlPreviewStore } from "../../server/html-preview.js";
import { McpConfigService } from "../../server/mcp-config.js";
import { listProjectDirectory } from "../../server/project-files.js";
import { ResourceStore } from "../../server/resources.js";
import { resolveComposerHistoryArtifacts } from "../../server/runtime-composer-artifacts.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";

const root = "C:\\audit\\Project";
const sibling = "C:\\audit\\project";
const outside = join(sibling, "private.txt");
const context = {
  sessionId: "s1",
  viewId: "v1",
  revision: 1,
  cwd: root,
  messages: [],
};
const resources = new ResourceStore();
const destinations = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
  destinations.clear();
  io.realpath.mockImplementation(
    async (path: string) => destinations.get(path) ?? path,
  );
  io.stat.mockImplementation(async (path: string) => ({
    ino: path === root ? 1n : 2n,
    dev: 1n,
    isDirectory: () => path === root || path === sibling,
    isFile: () => path !== root && path !== sibling,
  }));
  io.readFile.mockResolvedValue("{}");
  io.open.mockImplementation(async () => {
    throw new Error("Unauthorized file was opened");
  });
});
afterEach(async () => {
  await resources.close();
  vi.restoreAllMocks();
});

describe("workspace boundaries under a Windows case-sensitive directory contract", () => {
  it("refuses Files traversal through a link to a case-distinct sibling", async () => {
    destinations.set(join(root, "linked"), sibling);
    await expect(
      listProjectDirectory(root, "linked", true),
    ).rejects.toMatchObject({ status: 403 });
    expect(io.opendir).not.toHaveBeenCalled();
  });

  it("refuses exact selections before resolving an external case-distinct target", async () => {
    await expect(
      resources.resolve(
        context,
        "../project/private.txt",
        true,
        "../project/private.txt",
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(io.realpath).not.toHaveBeenCalledWith(outside);
    expect(io.open).not.toHaveBeenCalled();
  });

  it("does not grant workspace authority to a case-distinct canonical target", async () => {
    destinations.set(join(root, "linked.txt"), outside);
    await expect(
      resources.resolve(context, "linked.txt"),
    ).rejects.toMatchObject({ status: 403 });
    expect(io.open).not.toHaveBeenCalled();
  });

  it("refuses the same physical escape at the project-file prompt boundary", async () => {
    destinations.set(join(root, "linked.txt"), outside);
    await expect(resolveProjectFiles(root, ["linked.txt"])).rejects.toThrow(
      "outside the active project",
    );
    expect(io.stat).not.toHaveBeenCalledWith(outside);
  });

  it("does not recall a foreign file merely because a persisted path folds into cwd", async () => {
    const slot = {
      cwd: root,
      viewId: "v1",
      navigationLease: null,
      projection: {
        incarnation: "incarnation",
        leafId: null,
        composerHistoryMessages: () => [
          {
            role: "user",
            content: addAttachmentContext("Use", [], [outside]),
            __inspireMessageIndex: 0,
          },
        ],
      },
    } as unknown as RuntimeSlot;
    await expect(
      resolveComposerHistoryArtifacts(
        slot,
        {
          sessionId: "s1",
          message: "",
          historyArtifacts: {
            viewId: "v1",
            incarnation: "incarnation",
            effectiveLeafId: null,
            imageReferences: [],
            fileReferences: ["pi-file://0/0"],
          },
        },
        { ready: async () => {}, ownsPromptFile: () => false },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("not owned"),
    });
    expect(io.realpath).not.toHaveBeenCalledWith(outside);
  });

  it("rejects a project MCP link into the case-distinct project before reading or saving it", async () => {
    const lexical = join(root, ".pi", "mcp.json");
    destinations.set(lexical, join(sibling, ".pi", "mcp.json"));
    const service = new McpConfigService("C:\\agent");
    const snapshot = await service.read(root);
    expect(
      snapshot.files.find((file) => file.scope === "project"),
    ).toMatchObject({
      revision: "",
      error: expect.stringContaining("outside this project"),
    });
    expect(io.readFile).not.toHaveBeenCalledWith(lexical, "utf8");
    await expect(
      service.save(root, {
        scope: "project",
        revision: "a".repeat(64),
        name: "fixture",
        operation: "remove",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

async function preview() {
  const retained = {
    get: () => ({
      descriptor: { kind: "html" },
      path: join(root, "index.html"),
      workspaceRoot: root,
    }),
    revalidate: async () => {},
    openForServing: async () => ({ handle: { close: async () => {} } }),
  } as unknown as ResourceStore;
  const store = new HtmlPreviewStore(retained, async () => context);
  const grant = await store.create(
    "fixture-html",
    context,
    "<h1>Loaded snapshot</h1>",
  );
  const app = express();
  app.get("/html-preview/:id/*path", async (req, res, next) => {
    try {
      await store.serve(req, res);
    } catch (error) {
      next(error);
    }
  });
  app.use(
    (
      error: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(error.status ?? 500).send(error.message);
    },
  );
  return { app, prefix: "/html-preview/" + grant.id };
}

describe("HTML capability route with real Express decoding and Win32 filesystem contracts", () => {
  it("denies encoded backslash traversal into the independent case-distinct root without a junction", async () => {
    const { app, prefix } = await preview();
    const url = prefix + "/" + encodeURIComponent("..\\project\\private.txt");
    expect(new URL(url, "http://fixture.invalid").pathname).toContain(
      "..%5Cproject%5C",
    );
    await request(app).get(url).set("Origin", "null").expect(403);
    expect(io.realpath).not.toHaveBeenCalledWith(outside);
    expect(io.open).not.toHaveBeenCalled();
  });

  it("denies an in-root asset link whose canonical target is in that sibling", async () => {
    const { app, prefix } = await preview();
    destinations.set(join(root, "asset.txt"), outside);
    await request(app)
      .get(prefix + "/asset.txt")
      .expect(403);
    expect(io.open).not.toHaveBeenCalled();
  });

  it("accepts a proven directory spelling alias without granting another root", async () => {
    io.stat.mockResolvedValue({ ino: 1n, dev: 1n, isDirectory: () => true });
    const { app, prefix } = await preview();
    const response = await request(app)
      .get(prefix + "/" + encodeURIComponent("..\\project\\index.html"))
      .expect(200);
    expect(response.text).toBe("<h1>Loaded snapshot</h1>");
    expect(io.open).not.toHaveBeenCalled();
  });
});
