import { describe, expect, it } from "vitest";
import {
  collectSessionResourceReferences,
  isLocalResourceReference,
} from "../../shared/resource-references";
import { collectResources, MAX_RESOURCE_ROWS } from "../../src/resources";

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
          { type: "text", text: "Open [report](./out/report.pdf) but keep [Pi](https://pi.dev) external." },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "/tmp/input one.png" } },
        ],
      },
    ]);

    expect(resources.map((item) => item.reference).filter(Boolean)).toEqual([
      "/tmp/input one.png",
      "./out/report.pdf",
      "pi-embedded://0/1",
    ]);
    expect(resources.some((item) => item.source === "embedded" && item.mimeType === "image/png")).toBe(true);
    expect(resources.some((item) => item.reference === "https://pi.dev")).toBe(false);
  });

  it("understands file URLs, OSC 8 targets, inline-code paths, and @ mentions", () => {
    const osc = "\u001b]8;;file:///tmp/chart.png\u0007chart\u001b]8;;\u0007";
    const resources = collectSessionResourceReferences([{
      role: "assistant",
      content: [{ type: "text", text: `${osc}\nSee \`src/view.tsx\` and @notes/result.md.` }],
    }]);
    expect(resources.map((item) => item.reference)).toEqual([
      "file:///tmp/chart.png",
      "src/view.tsx",
      "notes/result.md",
    ]);
  });

  it("deduplicates the same file and keeps the newest, strongest reference", () => {
    const resources = collectSessionResourceReferences([
      { role: "assistant", content: [{ type: "text", text: "See `plot.png`." }] },
      { role: "assistant", content: [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "plot.png" } }] },
    ]);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ reference: "plot.png", source: "tool", toolName: "write" });
  });

  it("does not surface hidden custom content or independently hidden thinking", () => {
    const resources = collectSessionResourceReferences([
      { role: "assistant", content: [{ type: "thinking", thinking: "secret/path.pdf" }] },
      { role: "custom", display: false, content: [{ type: "text", text: "[hidden](hidden.png)" }] },
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
  });

  it("stops the recent-first walk at the presented bound, leaving authority callers complete", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: "assistant",
      content: [{ type: "text", text: `wrote \`file-${index}.md\`` }],
    }));

    const bounded = collectSessionResourceReferences(messages, MAX_RESOURCE_ROWS);
    expect(bounded).toHaveLength(MAX_RESOURCE_ROWS);
    // Newest first: the bound keeps the most recent references, not the first.
    expect(bounded[0]?.reference).toBe("file-19.md");
    expect(bounded.at(-1)?.reference).toBe(`file-${20 - MAX_RESOURCE_ROWS}.md`);
    // No limit means no truncation — the authorization path sees everything.
    expect(collectSessionResourceReferences(messages)).toHaveLength(20);
    expect(collectResources(messages, MAX_RESOURCE_ROWS)).toHaveLength(MAX_RESOURCE_ROWS);
  });
});
