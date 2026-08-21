import { describe, expect, it } from "vitest";
import { toolPresentationConfigurationSchema } from "../../shared/tool-presentation-config";
import type { ChatMessage, ToolCallContent } from "../../src/events";
import { compileToolPresentationRules } from "../../src/tool-presentations/declarative";
import {
  type ToolPresentationRule,
  toolPresentationSummaryText,
} from "../../src/tool-presentations/model";
import {
  createToolPresentationRegistry,
  toolPresentationRegistry,
} from "../../src/tool-presentations/registry";

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

describe("declarative tool presentation rules", () => {
  const configuration = toolPresentationConfigurationSchema.parse({
    version: 1,
    rules: {
      "user.fff.grep": {
        summary: [
          {
            value: { path: "args.pattern", prefix: "/", suffix: "/" },
          },
          {
            value: { literal: "in" },
            subdued: true,
          },
          {
            kind: "resource",
            value: { path: "args.path", fallback: "." },
          },
        ],
        blocks: [
          {
            type: "search",
            label: "Matches",
            source: { path: "result.text" },
            format: "grouped-lines",
            emptyValues: ["No matches found"],
            emptyText: "No matches found",
          },
        ],
      },
    },
    mappings: { grep: "user.fff.grep" },
  });

  it("compiles an explicit override and parses grouped custom search output", () => {
    const registry = createToolPresentationRegistry({
      userRules: compileToolPresentationRules(configuration),
      userMappings: configuration.mappings,
    });
    const presentation = registry.resolve({
      call: call("grep", { pattern: "needle", path: "src" }),
      result: result(
        [
          "[0 exact matches. Maybe you meant this?]",
          "src/a.ts  [often touched file]",
          " 4- before",
          " 5: needle",
          "",
          '[Continue with cursor="next"]',
        ].join("\n"),
      ),
    });

    expect(presentation?.ruleId).toBe("user.fff.grep");
    expect(
      presentation && toolPresentationSummaryText(presentation.summary),
    ).toBe("/needle/ in src");
    expect(presentation?.blocks()).toEqual([
      {
        type: "search",
        label: "Matches",
        groups: [
          {
            path: "src/a.ts",
            matches: [
              { line: 4, text: "before", match: false },
              { line: 5, text: "needle", match: true },
            ],
          },
        ],
      },
      {
        type: "notice",
        text: '0 exact matches. Maybe you meant this? · Continue with cursor="next"',
        tone: "muted",
      },
    ]);
  });

  it("bounds declarative structured output without discarding the selected rule", () => {
    const registry = createToolPresentationRegistry({
      userRules: compileToolPresentationRules(configuration),
      userMappings: configuration.mappings,
    });
    const output = [
      "src/large.ts",
      ...Array.from(
        { length: 1_001 },
        (_, index) => ` ${index + 1}: needle ${index + 1}`,
      ),
    ].join("\n");
    const blocks = registry
      .resolve({
        call: call("grep", { pattern: "needle" }),
        result: result(output),
      })
      ?.blocks();

    const search = blocks?.find((block) => block.type === "search");
    expect(search).toMatchObject({
      groups: [{ path: "src/large.ts" }],
    });
    expect(search?.type === "search" && search.groups[0]?.matches).toHaveLength(
      1_000,
    );
    expect(blocks?.at(-1)).toEqual({
      type: "notice",
      text: "Preview limited to 1000 matching lines",
      tone: "muted",
    });
  });

  it("bounds summary, property, and replacement previews", () => {
    const boundedConfiguration = toolPresentationConfigurationSchema.parse({
      version: 1,
      rules: {
        "user.example.bounded": {
          summary: [{ value: { path: "args.payload" } }],
          blocks: [
            {
              type: "properties",
              items: [{ label: "Output", value: { path: "result.text" } }],
            },
            {
              type: "replacement",
              label: "Requested change",
              oldText: { path: "result.details.old" },
              newText: { path: "result.details.new" },
            },
          ],
        },
      },
      mappings: { custom: "user.example.bounded" },
    });
    const registry = createToolPresentationRegistry({
      userRules: compileToolPresentationRules(boundedConfiguration),
      userMappings: boundedConfiguration.mappings,
    });
    const presentation = registry.resolve({
      call: call("custom", { payload: "x".repeat(200_000) }),
      result: result("y".repeat(200_000), {
        old: "a".repeat(200_000),
        new: "b".repeat(200_000),
      }),
    });
    const blocks = presentation?.blocks();
    const properties = blocks?.find((block) => block.type === "properties");
    const replacement = blocks?.find((block) => block.type === "replacement");

    expect(
      presentation && toolPresentationSummaryText(presentation.summary),
    ).toHaveLength(240);
    expect(
      properties?.type === "properties" && properties.items[0]?.value,
    ).toHaveLength(4_096);
    expect(
      replacement?.type === "replacement" && replacement.oldText,
    ).toHaveLength(100_002);
    expect(blocks?.filter((block) => block.type === "notice")).toHaveLength(2);
  });

  it("returns raw fallback when selected data does not match the declaration", () => {
    const registry = createToolPresentationRegistry({
      userRules: compileToolPresentationRules(configuration),
      userMappings: configuration.mappings,
    });
    expect(
      registry.resolve({ call: call("grep", { path: "src" }) }),
    ).toBeNull();
    expect(
      registry
        .resolve({
          call: call("grep", { pattern: "needle" }),
          result: result("not grouped search output"),
        })
        ?.blocks(),
    ).toBeNull();
  });

  it("rejects executable or expensive summary shapes at validation", () => {
    const unsafe = {
      version: 1,
      rules: {
        "user.custom.rule": {
          summary: [{ value: { path: "result.text" } }],
          blocks: [{ type: "html", source: { path: "result.text" } }],
        },
      },
      mappings: { custom: "user.custom.rule" },
    };
    expect(toolPresentationConfigurationSchema.safeParse(unsafe).success).toBe(
      false,
    );
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
