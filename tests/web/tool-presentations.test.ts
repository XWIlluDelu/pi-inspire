import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCallContent } from "../../src/events";
import {
  createToolPresentationRegistry,
  toolPresentationRegistry,
} from "../../src/tool-presentations/registry";
import {
  toolPresentationSummaryText,
  type ToolPresentationRule,
} from "../../src/tool-presentations/model";

function call(name: string, args: Record<string, unknown>): ToolCallContent {
  return { type: "toolCall", id: `${name}-1`, name, arguments: args };
}

function result(
  content: string,
  details?: unknown,
  isError = false,
): ChatMessage {
  return { role: "toolResult", content, details, isError };
}

describe("tool presentation registry", () => {
  it("lets one explicit user mapping replace a shipped name binding", () => {
    const shipped: ToolPresentationRule = {
      id: "inspire.pi.grep",
      present: () => ({
        summary: { parts: [{ kind: "text", text: "Pi grep" }] },
        blocks: () => [],
      }),
    };
    const fff: ToolPresentationRule = {
      id: "user.fff.grep",
      present: () => ({
        summary: { parts: [{ kind: "text", text: "FFF grep" }] },
        blocks: () => [],
      }),
    };
    const registry = createToolPresentationRegistry({
      builtInRules: [shipped],
      builtInMappings: { grep: shipped.id },
      userRules: [fff],
      userMappings: { grep: fff.id },
    });

    const resolved = registry.resolve({ call: call("grep", { pattern: "x" }) });
    expect(resolved?.ruleId).toBe("user.fff.grep");
    expect(resolved && toolPresentationSummaryText(resolved.summary)).toBe(
      "FFF grep",
    );
  });

  it("falls directly to raw when the selected override is missing or incompatible", () => {
    const shipped: ToolPresentationRule = {
      id: "inspire.pi.grep",
      present: () => ({
        summary: { parts: [{ kind: "text", text: "Pi grep" }] },
        blocks: () => [],
      }),
    };
    const incompatible: ToolPresentationRule = {
      id: "user.fff.grep",
      present: () => null,
    };
    const input = { call: call("grep", { pattern: "x" }) };

    expect(
      createToolPresentationRegistry({
        builtInRules: [shipped],
        builtInMappings: { grep: shipped.id },
        userMappings: { grep: "user.missing.grep" },
      }).resolve(input),
    ).toBeNull();
    expect(
      createToolPresentationRegistry({
        builtInRules: [shipped],
        builtInMappings: { grep: shipped.id },
        userRules: [incompatible],
        userMappings: { grep: incompatible.id },
      }).resolve(input),
    ).toBeNull();
  });
});

describe("shipped Pi tool rules", () => {
  it("keeps read resolution cheap and produces numbered content only on expansion", () => {
    const presentation = toolPresentationRegistry.resolve({
      call: call("read", { path: "src/app.ts", offset: 41, limit: 20 }),
      result: result(
        "const one = 1;\nconst two = 2;\n\n[17 more lines in file. Use offset=43 to continue.]",
      ),
    });

    expect(presentation?.ruleId).toBe("inspire.pi.read");
    expect(
      presentation && toolPresentationSummaryText(presentation.summary),
    ).toBe("src/app.ts · L41–42");
    expect(presentation?.blocks()).toEqual([
      {
        type: "properties",
        items: [
          { label: "File", value: "src/app.ts", resourceRef: "src/app.ts" },
          { label: "Range", value: "L41–42" },
        ],
      },
      {
        type: "code",
        label: "Contents",
        path: "src/app.ts",
        startLine: 41,
        text: "const one = 1;\nconst two = 2;",
      },
      {
        type: "notice",
        text: "17 more lines in file. Use offset=43 to continue.",
        tone: "muted",
      },
    ]);
  });

  it("projects native read images only inside the lazy body", () => {
    const presentation = toolPresentationRegistry.resolve({
      call: call("read", { path: "assets/pixel.png" }),
      result: {
        role: "toolResult",
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: "cG5n", mimeType: "image/png" },
        ],
        isError: false,
      },
    });

    expect(
      presentation && toolPresentationSummaryText(presentation.summary),
    ).toBe("assets/pixel.png · PNG image");
    expect(presentation?.blocks()).toContainEqual({
      type: "image",
      label: "Preview",
      data: "cG5n",
      mimeType: "image/png",
      alt: "assets/pixel.png",
    });
  });

  it("uses the successful edit result patch rather than requested replacement text", () => {
    const patch = [
      "--- src/app.ts",
      "+++ src/app.ts",
      "@@ -1,1 +1,1 @@",
      "-const value = 1;",
      "+const value = 2;",
      "",
    ].join("\n");
    const presentation = toolPresentationRegistry.resolve({
      call: call("edit", {
        path: "src/app.ts",
        edits: [{ oldText: "value = 1", newText: "value = 2" }],
      }),
      result: result("Successfully replaced 1 block(s) in src/app.ts.", {
        diff: "-1 const value = 1;\n+1 const value = 2;",
        patch,
      }),
    });

    expect(presentation?.blocks()).toEqual([
      {
        type: "diff",
        label: "Applied changes",
        path: "src/app.ts",
        text: patch,
      },
    ]);
  });

  it("keeps Pi's persisted single-edit shape renderable", () => {
    const presentation = toolPresentationRegistry.resolve({
      call: call("edit", {
        path: "src/legacy.ts",
        oldText: "before",
        newText: "after",
      }),
    });

    expect(presentation?.ruleId).toBe("inspire.pi.edit");
    expect(presentation?.blocks()).toEqual([
      {
        type: "replacement",
        label: "Requested replacement",
        path: "src/legacy.ts",
        oldText: "before",
        newText: "after",
      },
    ]);
  });

  it("groups native grep matches and separates authoritative limit metadata", () => {
    const presentation = toolPresentationRegistry.resolve({
      call: call("grep", {
        pattern: "needle",
        path: "src",
        glob: "*.ts",
        context: 1,
      }),
      result: result(
        [
          "a.ts-4- before",
          "a.ts:5: needle here",
          "a.ts-6- after",
          "b.ts:9: another needle",
          "",
          "[2 matches limit reached. Use limit=4 for more, or refine pattern]",
        ].join("\n"),
        { matchLimitReached: 2 },
      ),
    });
    const blocks = presentation?.blocks();

    expect(blocks?.find((block) => block.type === "search")).toMatchObject({
      groups: [
        {
          path: "a.ts",
          matches: [
            { line: 4, text: "before", match: false },
            { line: 5, text: "needle here", match: true },
            { line: 6, text: "after", match: false },
          ],
        },
        {
          path: "b.ts",
          matches: [{ line: 9, text: "another needle", match: true }],
        },
      ],
    });
    expect(blocks?.at(-1)).toEqual({
      type: "notice",
      text: "2 match limit reached",
      tone: "warning",
    });
  });

  it("rejects malformed native calls and incompatible successful edit results", () => {
    expect(
      toolPresentationRegistry.resolve({
        call: call("read", { path: 17 }),
      }),
    ).toBeNull();
    const incompatible = toolPresentationRegistry.resolve({
      call: call("edit", {
        path: "a.ts",
        edits: [{ oldText: "a", newText: "b" }],
      }),
      result: result("done", { diff: "-1 a\n+1 b" }),
    });
    expect(incompatible).not.toBeNull();
    expect(incompatible?.blocks()).toBeNull();
  });
});
