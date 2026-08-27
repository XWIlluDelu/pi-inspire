import { describe, expect, it } from "vitest";
import {
  collectSessionResourceReferences,
  isLocalResourceReference,
  RESOURCE_LIST_INITIAL_SIZE,
  resourceReferenceLine,
  stripResourceLocation,
} from "../../shared/resource-references";

describe("Pi resource references", () => {
  it("collects structured tool paths, local Markdown targets, attachment tags, and embedded images", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "user",
        content: [
          { type: "text", text: '<file name="/tmp/input one.png"></file>' },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Open [report](./out/report.pdf) but keep [Pi](https://pi.dev) external.",
          },
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: {
              path: "/tmp/input one.png",
              saveDir: "/tmp/generated-output",
            },
          },
        ],
      },
    ]);

    expect(resources.map((item) => item.reference).filter(Boolean)).toEqual([
      "/tmp/input one.png",
      "./out/report.pdf",
      "pi-embedded://0/1",
    ]);
    expect(
      resources.some(
        (item) => item.source === "embedded" && item.mimeType === "image/png",
      ),
    ).toBe(true);
    expect(resources.some((item) => item.reference === "https://pi.dev")).toBe(
      false,
    );
    expect(
      resources.some((item) => item.reference === "/tmp/generated-output"),
    ).toBe(false);
  });

  it("keeps embedded coordinates aligned with the original content array", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "user",
        content: [
          "malformed primitive",
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      },
    ]);

    expect(resources.map((item) => item.reference)).toEqual([
      "pi-embedded://0/1",
    ]);
  });

  it("understands file URLs, OSC 8 targets, inline-code paths, and @ mentions", () => {
    const osc = "\u001b]8;;file:///tmp/chart.png\u0007chart\u001b]8;;\u0007";
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `${osc}\nSee \`src/view.tsx\` and @notes/result.md.`,
          },
        ],
      },
    ]);
    expect(resources.map((item) => item.reference)).toEqual([
      "notes/result.md",
      "src/view.tsx",
      "file:///tmp/chart.png",
    ]);
  });

  it("keeps references within one text part in recent-first order", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "First `old.md`, then [new](src/new.ts).",
          },
        ],
      },
    ]);
    expect(resources.map((item) => item.reference)).toEqual([
      "src/new.ts",
      "old.md",
    ]);
  });

  it("deduplicates the same file and keeps the newest, strongest reference", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [{ type: "text", text: "See `plot.png`." }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "write-1",
            name: "write",
            arguments: { path: "plot.png" },
          },
        ],
      },
    ]);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      reference: "plot.png",
      source: "tool",
      toolName: "write",
    });
  });

  it("does not surface hidden custom content or independently hidden thinking", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "secret/path.pdf" }],
      },
      {
        role: "custom",
        display: false,
        content: [{ type: "text", text: "[hidden](hidden.png)" }],
      },
    ]);
    expect(resources).toEqual([]);
  });

  it("rejects remote and executable URL schemes without rejecting ordinary local files", () => {
    expect(isLocalResourceReference("https://example.com/a.pdf")).toBe(false);
    expect(isLocalResourceReference("javascript:alert(1)")).toBe(false);
    expect(isLocalResourceReference("example.com/report.pdf")).toBe(false);
    expect(isLocalResourceReference("report.pdf#L2")).toBe(true);
    expect(isLocalResourceReference("report.pdf#page=2")).toBe(true);
    expect(isLocalResourceReference("../figures/chart.svg")).toBe(true);
    expect(isLocalResourceReference("/repo/LICENSE")).toBe(true);
    expect(isLocalResourceReference("/unstaged/")).toBe(false);
    expect(isLocalResourceReference("/**")).toBe(false);
  });

  it("uses one location grammar for resolution and source-line navigation", () => {
    expect(stripResourceLocation("src/view.tsx:123:7")).toBe("src/view.tsx");
    expect(stripResourceLocation("src/view.tsx#L9-L12")).toBe("src/view.tsx");
    expect(resourceReferenceLine("@src/view.tsx:123:7")).toBe(123);
    expect(resourceReferenceLine("<src/view.tsx#L9-L12>")).toBe(9);
    expect(resourceReferenceLine("src/view.tsx:4?raw=1")).toBe(4);
    expect(resourceReferenceLine("src/view.tsx#L0")).toBeNull();
    expect(resourceReferenceLine("src/view.tsx")).toBeNull();
  });

  it("stops the recent-first walk at the presented bound, leaving authority callers complete", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: "assistant",
      content: [{ type: "text", text: `wrote \`file-${index}.md\`` }],
    }));

    const bounded = collectSessionResourceReferences(
      messages,
      RESOURCE_LIST_INITIAL_SIZE,
    );
    expect(bounded).toHaveLength(RESOURCE_LIST_INITIAL_SIZE);
    // Newest first: the bound keeps the most recent references, not the first.
    expect(bounded[0]?.reference).toBe("file-19.md");
    expect(bounded.at(-1)?.reference).toBe(
      `file-${20 - RESOURCE_LIST_INITIAL_SIZE}.md`,
    );
    // No limit means no truncation — the authorization path sees everything.
    expect(collectSessionResourceReferences(messages)).toHaveLength(20);
  });
});
