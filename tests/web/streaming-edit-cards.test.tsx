// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCard } from "../../src/components/transcript-cards";
import type { ChatMessage, ToolCallContent } from "../../src/events";
import { toolPresentationRegistry } from "../../src/tool-presentations/registry";

function call(args: Record<string, unknown>, partial = true): ToolCallContent {
  return {
    type: "toolCall",
    id: "edit-stream",
    name: "edit",
    arguments: args,
    ...(partial
      ? {
          __inspireToolCall: {
            phase: "streaming" as const,
            characters: 0,
            truncated: false,
          },
        }
      : {}),
  };
}

function card(toolCall: ToolCallContent, result?: ChatMessage, live = true) {
  return (
    <ToolCard
      call={toolCall}
      result={result}
      activity={undefined}
      live={live}
      visibility="expanded"
    />
  );
}

const edits = [
  { oldText: "before one\nold line", newText: "after one\nnew line" },
  { oldText: "before two", newText: 'after two\n"quoted" \\ unicode 中文' },
  { oldText: "before three", newText: "" },
];

describe("streaming native edit cards", () => {
  const arrayStages = [
    {},
    { edits: [] },
    { edits: [{}] },
    { edits: [{ oldText: "" }] },
    { edits: [{ oldText: "before one" }] },
    { edits: [{ ...edits[0], newText: "" }] },
    { edits: [edits[0]] },
    { edits: [edits[0], {}] },
    { edits: [edits[0], { newText: "after two" }] },
    { edits: [edits[0], edits[1]] },
    { edits: [edits[0], edits[1], {}] },
    { edits },
  ];
  it.each([
    arrayStages.map((args) => ({ path: "src/example.ts", ...args })),
    [...arrayStages, { edits, path: "src/example.ts" }],
    [
      {},
      { path: "src/example.ts" },
      { path: "src/example.ts", oldText: "" },
      { path: "src/example.ts", oldText: "before" },
      { path: "src/example.ts", oldText: "before", newText: "after" },
    ],
    [
      {},
      { newText: "" },
      { newText: "after" },
      { newText: "after", oldText: "" },
      { newText: "after", oldText: "before" },
      { newText: "after", oldText: "before", path: "src/example.ts" },
    ],
  ])(
    "keeps typed content as fields and array items arrive: %j",
    (...stages) => {
      const { container, rerender } = render(card(call({})));
      const shell = container.querySelector(".card");
      let firstRemoved: Element | null = null;
      for (const args of stages) {
        rerender(card(call(args)));
        expect(
          container.querySelector('[data-tool-rule="inspire.pi.edit"]'),
        ).not.toBeNull();
        expect(
          screen.queryByText("Arguments (partial)"),
        ).not.toBeInTheDocument();
        expect(container.querySelector(".card")).toBe(shell);
        if (firstRemoved) expect(container.contains(firstRemoved)).toBe(true);
        firstRemoved ??= container.querySelector(".diff__line--del");
      }
      expect(screen.getByText("Generating arguments…")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Copy edit argument preview" }),
      ).toBeInTheDocument();
      expect(container.querySelector("button[data-file-path]")).toBeNull();
      rerender(card(call(stages.at(-1)!, false)));
      expect(screen.getByText("Waiting to execute…")).toBeInTheDocument();
      expect(container.querySelector("button[data-file-path]")).not.toBeNull();
    },
  );

  it("does not render missing sides as empty replacements or discard prior rows", () => {
    const { container, rerender } = render(
      card(call({ path: "src/a.ts", edits: [edits[0]] })),
    );
    const first = container.querySelector(".diff");
    rerender(card(call({ path: "src/a.ts", edits: [edits[0], {}] })));
    expect(container.querySelector(".diff")).toBe(first);
    expect(container.querySelectorAll(".diff__line--del")).toHaveLength(2);
    expect(container.querySelectorAll(".diff__line--add")).toHaveLength(2);
    rerender(
      card(
        call({
          path: "src/a.ts",
          edits: [edits[0], { oldText: "second before" }],
        }),
      ),
    );
    expect(container.querySelectorAll(".diff__line--del")).toHaveLength(3);
    expect(container.querySelectorAll(".diff__line--add")).toHaveLength(2);
    rerender(
      card(
        call({
          path: "src/a.ts",
          edits: [edits[0], { oldText: "second before", newText: "" }],
        }),
      ),
    );
    expect(container.querySelectorAll(".diff__line--add")).toHaveLength(3);
    expect(container.querySelector(".diff")).toBe(first);
  });

  it("keeps a truncated incomplete edit typed on interruption and on a fresh observer", () => {
    // A bounded Host preview can freeze before the next newText field arrives.
    const partial = call({
      path: "src/a.ts",
      edits: [edits[0], { oldText: "old line\n".repeat(3_000) }],
    });
    partial.__inspireToolCall = {
      phase: "interrupted",
      characters: 27_000,
      truncated: true,
    };
    const { container, unmount } = render(card(partial, undefined, false));
    expect(
      container.querySelector('[data-tool-rule="inspire.pi.edit"]'),
    ).not.toBeNull();
    expect(screen.getByText("Not executed")).toBeInTheDocument();
    expect(screen.getByText("Argument preview truncated")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Show all/ }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelectorAll(".diff")[1]?.querySelectorAll(".diff__line"),
    ).toHaveLength(400);
    const markup = container.querySelector(".tool-presentation")?.innerHTML;
    unmount();
    const fresh = render(card(structuredClone(partial), undefined, false));
    expect(fresh.container.querySelector(".tool-presentation")?.innerHTML).toBe(
      markup,
    );
  });

  it("adopts only the authoritative success patch, and retains requested content on failure", () => {
    const complete = call({ path: "src/a.ts", edits: [edits[0]] }, false);
    const { container, rerender } = render(card(complete));
    const patch =
      "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-applied before\n+applied after\n";
    rerender(
      card(complete, {
        role: "toolResult",
        content: "done",
        details: { patch },
      }),
    );
    expect(screen.getByText("Applied changes")).toBeInTheDocument();
    expect(container.querySelector(".diff__line--add")).toHaveTextContent(
      "+applied after",
    );
    rerender(
      card(complete, {
        role: "toolResult",
        content: "edit rejected",
        isError: true,
      }),
    );
    expect(screen.getByText("Requested replacement")).toBeInTheDocument();
    expect(screen.getByText("edit rejected")).toBeInTheDocument();
    expect(screen.queryByText("Applied changes")).not.toBeInTheDocument();
    rerender(
      card(complete, { role: "toolResult", content: "incompatible success" }),
    );
    expect(screen.getByText("Arguments")).toBeInTheDocument();
  });

  it.each([
    { path: 12, edits },
    { path: "a", edits: null },
    { path: "a", edits: {} },
    { path: "a", edits: [null] },
    { path: "a", edits: [7] },
    { path: "a", edits: [{ oldText: false }] },
    { path: "a", edits: [{ newText: [] }] },
    { path: "a", oldText: null },
    { path: "a", newText: 5 },
  ])("does not tolerate wrong types even during streaming: %j", (args) => {
    expect(toolPresentationRegistry.resolve({ call: call(args) })).toBeNull();
  });

  it.each([
    {},
    { path: "a" },
    { path: "a", edits: [] },
    { path: "a", edits: [{}] },
    { path: "a", edits: [{ oldText: "a" }] },
    { path: "a", newText: "b" },
  ])("keeps completed malformed calls strict: %j", (args) => {
    expect(
      toolPresentationRegistry.resolve({ call: call(args, false) }),
    ).toBeNull();
  });
});
