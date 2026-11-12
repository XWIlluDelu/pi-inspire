// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolPresentationConfigurationSchema } from "../../shared/tool-presentation-config";
import { Transcript } from "../../src/components/Transcript";
import { ToolCard } from "../../src/components/transcript-cards";
import { UnpairedToolResultRow } from "../../src/components/transcript-rows";
import type { ChatMessage, ToolCallContent } from "../../src/events";
import { store } from "../../src/store";
import {
  configureToolPresentationRegistry,
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

afterEach(() => configureToolPresentationRegistry());

function card(
  toolCall: ToolCallContent,
  toolResult?: ChatMessage,
  visibility: "expanded" | "collapsed" = "expanded",
  live = false,
) {
  return (
    <ToolCard
      call={toolCall}
      result={toolResult}
      activity={undefined}
      live={live}
      visibility={visibility}
    />
  );
}

describe("generic tool fallback", () => {
  it("keeps an unknown tool's live partial arguments directly visible", () => {
    const partial: ToolCallContent = {
      ...call("custom_tool", { prompt: "incoming argument text" }),
      __inspireToolCall: {
        phase: "streaming",
        characters: 40,
        truncated: false,
      },
    };
    render(
      <ToolCard
        call={partial}
        result={undefined}
        activity={undefined}
        live
        visibility="expanded"
      />,
    );
    expect(screen.getByText(/incoming argument text/)).toBeVisible();
  });

  it("keeps raster previews and text when other image blocks are invalid", () => {
    render(
      card(call("extension_tool", {}), {
        role: "toolResult",
        content: [
          { type: "text", text: "Generated preview" },
          { type: "image", mimeType: "image/png", data: "cG5n" },
          { type: "image", mimeType: "image/svg+xml", data: "c3Zn" },
          { type: "image", mimeType: "image/png", data: "invalid<>" },
          { type: "image" },
        ],
      }),
    );
    expect(screen.getByText("Generated preview")).toBeVisible();
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "data:image/png;base64,cG5n",
    );
    expect(screen.getAllByText(/Image unavailable/)).toHaveLength(3);
    fireEvent.click(
      screen.getByRole("button", { name: "Preview Tool result image 1" }),
    );
    expect(screen.getByRole("dialog", { name: "Image preview" })).toBeVisible();
  });

  it.each([
    { details: { line: 4 }, content: [] },
    { content: { line: 4 } },
    { content: [{ type: "extensionData", line: 4 }] },
  ])("preserves structured output for inspection: %j", async (payload) => {
    render(
      card(call("extension_tool", {}), { role: "toolResult", ...payload }),
    );
    expect(screen.queryByText(/"line": 4/)).toBeNull();
    expect(screen.queryByText("No output")).toBeNull();
    fireEvent.click(screen.getByText("Result details"));
    expect(await screen.findByText(/"line": 4/)).toBeVisible();
  });

  it("distinguishes an empty result from text with optional metadata", () => {
    const extension = call("extension_tool", {});
    const { rerender } = render(card(extension, result("", {})));
    expect(screen.getByText("No output")).toBeVisible();
    rerender(card(extension, result("Useful output", { tokens: 1024 })));
    expect(screen.getByText("Useful output")).toBeVisible();
  });

  it("opens or reveals the full file argument without treating a command as a path", () => {
    const path = `src/${"long-directory/".repeat(12)}important-file.ts`;
    const command = "src/not-a-resource.ts";
    const open = vi.spyOn(store, "openResource").mockResolvedValue(undefined);
    const reveal = vi
      .spyOn(store, "showInFileManager")
      .mockResolvedValue(undefined);
    const { rerender } = render(
      card(call("extension_tool", { file_path: path }), undefined, "collapsed"),
    );
    const reference = screen.getByRole("button", { name: path });
    fireEvent.click(reference);
    fireEvent.click(reference, { ctrlKey: true });
    fireEvent.click(reference, { metaKey: true });
    expect(open).toHaveBeenCalledExactlyOnceWith(path);
    expect(reveal.mock.calls).toEqual([[path], [path]]);

    rerender(card(call("extension_tool", { command }), undefined, "collapsed"));
    expect(screen.getByText(command)).toBeVisible();
    expect(screen.queryByRole("button", { name: command })).toBeNull();
  });
});

describe("saved tool images", () => {
  const sessionId = "saved-session";
  const viewId = "saved-view";
  const incarnation = "saved-incarnation";
  const projectedPng = { type: "image", mimeType: "image/png" } as const;
  const transcript = (messages: ChatMessage[]) => (
    <Transcript
      sessionId={sessionId}
      viewId={viewId}
      projectionIncarnation={incarnation}
      messages={messages}
      streaming={false}
      thinkingVisibility="collapsed"
      activityFoldVisibility="expanded"
      toolVisibility="expanded"
    />
  );
  const savedImageResult = (
    toolCall: ToolCallContent,
    content: ChatMessage["content"],
  ): ChatMessage => ({
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    __inspireMessageIndex: 2,
    content,
  });

  it.each(["generic", "unpaired"] as const)(
    "preserves the original part index for each %s tool image",
    async (presentation) => {
      const toolCall = call("image_tool", {});
      const load = vi
        .spyOn(store, "loadTranscriptImage")
        .mockResolvedValue(new Blob(["same bytes"], { type: "image/png" }));
      const images = savedImageResult(toolCall, [
        { type: "text", text: "Two images" },
        projectedPng,
        projectedPng,
      ]);
      const { unmount } = render(
        transcript(
          presentation === "unpaired"
            ? [images]
            : [{ role: "assistant", content: [toolCall] }, images],
        ),
      );
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Preview Tool result image 1",
        }),
      );
      const navigation = within(
        screen.getByRole("dialog", { name: "Image preview" }),
      ).getByRole("group", { name: "Image navigation" });
      expect(navigation).toHaveTextContent("1 / 2");
      fireEvent.click(
        within(navigation).getByRole("button", { name: "Next image" }),
      );
      expect(navigation).toHaveTextContent("2 / 2");
      for (const index of [1, 2])
        expect(load).toHaveBeenCalledWith(
          sessionId,
          viewId,
          `${viewId}\u0000${incarnation}`,
          `pi-embedded://2/${index}`,
          expect.any(AbortSignal),
        );
      unmount();
      for (const request of load.mock.calls)
        expect(request[4].aborted).toBe(true);
    },
  );
});

describe("native Pi tool cards", () => {
  it("retains an unpaired result's text, image and structured data without inventing input", async () => {
    render(
      <UnpairedToolResultRow
        visibility="expanded"
        message={{
          role: "toolResult",
          toolCallId: "missing-call",
          toolName: "plot",
          content: [
            { type: "text", text: "Computed spectrum" },
            { type: "image", mimeType: "image/png", data: "AAAA" },
          ],
          details: { peak: 12.4 },
        }}
      />,
    );
    expect(screen.getByText("Computed spectrum")).toBeInTheDocument();
    expect(screen.getByAltText("Tool result image 1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Result details"));
    expect(await screen.findByText(/"peak": 12.4/)).toBeInTheDocument();
  });

  it.each(["native", "configured"])(
    "merges overlapping %s search context without losing match emphasis or changed text",
    (format) => {
      if (format === "configured")
        configureToolPresentationRegistry(
          toolPresentationConfigurationSchema.parse({
            version: 1,
            rules: {
              "test.grouped": {
                summary: [{ value: { path: "args.pattern" } }],
                blocks: [
                  {
                    type: "search",
                    source: { path: "result.text" },
                    format: "grouped-lines",
                  },
                ],
              },
            },
            mappings: { grep: "test.grouped" },
          }),
        );
      const rows = [
        "1- before",
        "2- target()",
        "2- changed()",
        "2: target()",
        "3- after",
      ];
      const output =
        format === "configured"
          ? `src/a.ts\n${rows.map((line) => ` ${line}`).join("\n")}`
          : rows
              .map((line) => `src/a.ts${line.includes(":") ? ":" : "-"}${line}`)
              .join("\n");
      const { container } = render(
        card(call("grep", { pattern: "target", path: "src" }), result(output)),
      );
      expect(container.querySelectorAll(".tool-search-line")).toHaveLength(4);
      expect(
        container.querySelectorAll(".tool-search-line--match"),
      ).toHaveLength(1);
      expect(
        container.querySelector(".tool-search-line--match code"),
      ).toHaveTextContent("target()");
      expect(screen.getByText("changed()")).toBeInTheDocument();
    },
  );

  it("renders bounded arguments on demand and keeps interrupted previews unexecuted", () => {
    const partial: ToolCallContent = {
      ...call("write", { path: "src/new.ts", content: "line\n".repeat(1_000) }),
      __inspireToolCall: {
        phase: "streaming",
        characters: 5_000,
        truncated: true,
      },
    };
    const preview = (visibility: "collapsed" | "expanded", live: boolean) => (
      <ToolCard
        call={partial}
        result={undefined}
        activity={undefined}
        live={live}
        visibility={visibility}
      />
    );
    const { container, rerender } = render(preview("collapsed", true));
    expect(screen.queryByRole("group", { name: "Code" })).toBeNull();
    expect(screen.getByLabelText("generating arguments")).toBeVisible();
    rerender(preview("expanded", true));
    expect(container.querySelectorAll(".tool-code__line")).toHaveLength(400);
    expect(screen.getByText("Argument preview truncated")).toBeInTheDocument();
    expect(screen.getByText("Showing first 400 lines")).toBeInTheDocument();
    rerender(preview("expanded", false));
    expect(screen.getByText("Not executed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy write argument preview" }),
    ).toBeInTheDocument();
  });
  it("uses sanitized Markdown for a matching override and raw output when it cannot render", async () => {
    configureToolPresentationRegistry(
      toolPresentationConfigurationSchema.parse({
        version: 1,
        rules: {
          "user.example.markdown": {
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
        mappings: { grep: "user.example.markdown" },
      }),
    );
    const { rerender } = render(
      card(
        call("grep", { pattern: "needle", query: "Inspect evidence" }),
        result("## Finding\n\n**Supported** [unsafe](javascript:alert(1))"),
      ),
    );

    expect(
      await screen.findByRole("heading", { name: "Finding" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Supported")).toBeInTheDocument();
    expect(screen.getByText("unsafe").closest("a")).not.toHaveAttribute("href");

    const rawOutput = "src/app.ts:1: needle";
    rerender(card(call("grep", { pattern: "needle" }), result(rawOutput)));
    expect(
      screen.getByRole("group", { name: "Result text" }),
    ).toHaveTextContent(rawOutput);
    fireEvent.click(screen.getByText("Arguments"));
    expect(
      await screen.findByRole("group", { name: "Arguments" }),
    ).toHaveTextContent("needle");
  });
});

describe("native edit cards", () => {
  const path = "src/experiments/analysis/cross-calibration/fit-results.ts";
  const edits = [
    { oldText: "before one\nold line", newText: "after one\nnew line" },
    { oldText: "before two", newText: 'after two\n"quoted" \\ unicode 中文' },
    { oldText: "before three", newText: "" },
  ];
  const streaming = (
    args: Record<string, unknown>,
    phase: "streaming" | "interrupted" = "streaming",
  ): ToolCallContent => ({
    ...call("edit", args),
    __inspireToolCall: {
      phase,
      characters: phase === "interrupted" ? 27_000 : 0,
      truncated: phase === "interrupted",
    },
  });

  it.each([
    {
      shape: "array",
      stages: [
        { edits: [{ newText: "" }] },
        { edits: [edits[0], {}] },
        { edits, path },
      ],
    },
    {
      shape: "single",
      stages: [
        { path, oldText: "" },
        { path, oldText: "before", newText: "after" },
      ],
    },
  ])(
    "stays inspectable as a $shape edit streams before execution",
    ({ stages }) => {
      const { rerender } = render(
        card(streaming({}), undefined, "expanded", true),
      );
      for (const args of stages) {
        rerender(card(streaming(args), undefined, "expanded", true));
        expect(screen.getByText("Generating arguments…")).toBeVisible();
        expect(
          screen.getByRole("button", { name: "Copy edit argument preview" }),
        ).toBeVisible();
        expect(screen.queryByRole("button", { name: path })).toBeNull();
      }
      rerender(card(call("edit", stages.at(-1)!), undefined, "expanded", true));
      expect(screen.getByText("Waiting to execute…")).toBeVisible();
      expect(screen.getAllByRole("button", { name: path })[0]).toBeVisible();
    },
  );

  it("adds the next edit only after its fields arrive and keeps the interrupted preview bounded", () => {
    const preview = (second: Record<string, unknown>) =>
      card(
        streaming({ path, edits: [edits[0], second] }),
        undefined,
        "expanded",
        true,
      );
    const { container, rerender, unmount } = render(preview({}));
    const added = () => container.querySelectorAll(".diff__line--add");
    expect(added()).toHaveLength(2);
    rerender(preview({ oldText: "second before" }));
    expect(added()).toHaveLength(2);
    expect(container.querySelectorAll(".diff__line--del")).toHaveLength(3);
    rerender(preview({ oldText: "second before", newText: "" }));
    expect(added()).toHaveLength(3);
    expect(added()[0]).toHaveTextContent("after one");

    unmount();
    const interrupted = render(
      card(
        streaming(
          {
            path,
            edits: [edits[0], { oldText: "old line\n".repeat(3_000) }],
          },
          "interrupted",
        ),
      ),
    );
    expect(screen.getByText("Not executed")).toBeVisible();
    expect(screen.getByText("Argument preview truncated")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    expect(
      interrupted.container
        .querySelectorAll(".diff")[1]
        ?.querySelectorAll(".diff__line"),
    ).toHaveLength(400);
  });

  it("links the full path from the authoritative success patch and shows requested changes on failure", () => {
    const open = vi.spyOn(store, "openResource").mockResolvedValue(undefined);
    const request = call("edit", { path, edits: [edits[0]] });
    const patch = `--- ${path}\n+++ ${path}\n@@ -1 +1 @@\n-applied before\n+applied after\n`;
    const { container, rerender } = render(
      card(
        request,
        result("done", {
          diff: "-1 fallback before\n+1 fallback after",
          patch,
        }),
      ),
    );
    expect(screen.getByText("Applied changes")).toBeVisible();
    expect(container.querySelector(".diff__line--add")).toHaveTextContent(
      "+applied after",
    );
    fireEvent.click(screen.getByRole("button", { name: path }));
    expect(open).toHaveBeenCalledExactlyOnceWith(path);
    rerender(card(request, result("edit rejected", undefined, true)));
    expect(screen.getByText("Requested replacement")).toBeVisible();
    expect(screen.getByText("edit rejected")).toBeVisible();
    rerender(card(request, result("done", { diff: "-1 a\n+1 b" })));
    expect(screen.getByText("Arguments")).toBeVisible();
  });

  it.each([
    { path: 12, edits },
    { path: "a", edits: null },
    { path: "a", edits: [7] },
    { path: "a", edits: [{ oldText: false }] },
    { path: "a", newText: 5 },
  ])("rejects wrongly typed fields during streaming: %j", (args) => {
    expect(
      toolPresentationRegistry.resolve({ call: streaming(args) }),
    ).toBeNull();
  });

  it.each([
    {},
    { path: "a", edits: [] },
    { path: "a", edits: [{ oldText: "a" }] },
    { path: "a", newText: "b" },
  ])(
    "rejects completed edits that never received the required fields: %j",
    (args) => {
      expect(
        toolPresentationRegistry.resolve({ call: call("edit", args) }),
      ).toBeNull();
    },
  );
});
