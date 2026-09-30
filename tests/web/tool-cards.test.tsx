// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toolPresentationConfigurationSchema } from "../../shared/tool-presentation-config";
import { ToolCard } from "../../src/components/transcript-cards";
import { UnpairedToolResultRow } from "../../src/components/transcript-rows";
import type { ChatMessage, ToolCallContent } from "../../src/events";
import { configureToolPresentationRegistry } from "../../src/tool-presentations/registry";

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
) {
  return (
    <ToolCard
      call={toolCall}
      result={toolResult}
      activity={undefined}
      live={false}
      visibility={visibility}
    />
  );
}

describe("native Pi tool cards", () => {
  it.each(["bash", "powershell"])(
    "renders %s as a native terminal card",
    (name) => {
      const { container } = render(
        card(
          call(name, { command: "echo ready" }),
          result("\u001b[32mReady\u001b[0m"),
        ),
      );
      expect(
        container.querySelector(`[data-tool-rule="inspire.pi.${name}"]`),
      ).not.toBeNull();
      expect(screen.getByRole("group", { name: "Command" })).toHaveTextContent(
        "echo ready",
      );
      expect(screen.getByRole("group", { name: "Output" })).toHaveTextContent(
        "Ready",
      );
      expect(screen.queryByText("Arguments")).not.toBeInTheDocument();
    },
  );

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
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();
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

  it("shows the write shell early, streams its code in place, then distinguishes waiting, execution and success", () => {
    const initial: ToolCallContent = {
      ...call("write", {}),
      __inspireToolCall: {
        phase: "streaming",
        characters: 0,
        truncated: false,
      },
    };
    const view = (
      toolCall: ToolCallContent,
      activity?: { id: string; name: string; phase: "running" | "done" },
      toolResult?: ChatMessage,
    ) => (
      <ToolCard
        call={toolCall}
        result={toolResult}
        activity={activity}
        live
        visibility="expanded"
      />
    );
    const { container, rerender } = render(view(initial));
    const shell = container.querySelector(".card");
    expect(
      container.querySelector('[data-tool-rule="inspire.pi.write"]'),
    ).not.toBeNull();
    expect(screen.getByText("Generating arguments…")).toBeInTheDocument();
    expect(screen.queryByText("No result recorded")).not.toBeInTheDocument();
    const partial = {
      ...initial,
      arguments: { path: "src/new.ts", content: "const first = 1;" },
    };
    rerender(view(partial));
    expect(container.querySelector(".card")).toBe(shell);
    expect(screen.getByText("const first = 1;")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "src/new.ts" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy write argument preview" }),
    ).toBeInTheDocument();
    const complete = call("write", {
      path: "src/new.ts",
      content: "const first = 1;\nconst second = 2;",
    });
    rerender(view(complete));
    expect(screen.getByText("Waiting to execute…")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "src/new.ts" }),
    ).toBeInTheDocument();
    rerender(
      view(complete, { id: complete.id, name: "write", phase: "running" }),
    );
    expect(screen.getByText("Running…")).toBeInTheDocument();
    rerender(
      view(
        complete,
        { id: complete.id, name: "write", phase: "done" },
        result("Successfully wrote file"),
      ),
    );
    expect(screen.getByLabelText("finished")).toBeInTheDocument();
    expect(screen.queryByText("Generating arguments…")).not.toBeInTheDocument();
    expect(container.querySelector(".card")).toBe(shell);
  });

  it("keeps large argument previews bounded and interrupted previews unexecuted", () => {
    const partial: ToolCallContent = {
      ...call("write", { path: "src/new.ts", content: "line\n".repeat(1_000) }),
      __inspireToolCall: {
        phase: "streaming",
        characters: 5_000,
        truncated: true,
      },
    };
    const { container, rerender } = render(
      <ToolCard
        call={partial}
        result={undefined}
        activity={undefined}
        live
        visibility="expanded"
      />,
    );
    expect(container.querySelectorAll(".tool-code__line")).toHaveLength(400);
    expect(screen.getByText("Argument preview truncated")).toBeInTheDocument();
    expect(screen.getByText("Showing first 400 lines")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Show all/ }),
    ).not.toBeInTheDocument();
    rerender(
      <ToolCard
        call={partial}
        result={undefined}
        activity={undefined}
        live={false}
        visibility="expanded"
      />,
    );
    expect(screen.getByText("Not executed")).toBeInTheDocument();
    expect(screen.queryByLabelText("finished")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy write argument preview" }),
    ).toBeInTheDocument();
  });

  it("does not materialize a growing code body while collapsed", () => {
    const partial: ToolCallContent = {
      ...call("write", { path: "src/new.ts", content: "line\n".repeat(1_000) }),
      __inspireToolCall: {
        phase: "streaming",
        characters: 5_000,
        truncated: false,
      },
    };
    const { container } = render(
      <ToolCard
        call={partial}
        result={undefined}
        activity={undefined}
        live
        visibility="collapsed"
      />,
    );
    expect(container.querySelector(".tool-code")).toBeNull();
    expect(container.querySelector(".card__body")).toBeNull();
    expect(screen.getByLabelText("generating arguments")).toBeInTheDocument();
  });
  it("renders a native read as a file view while an unknown tool stays raw", () => {
    const { container } = render(
      <>
        {card(
          call("read", { path: "src/app.ts", offset: 41, limit: 2 }),
          result("const one = 1;\nconst two = 2;"),
        )}
        {card(call("custom_tool", { payload: 7 }), result("custom output"))}
      </>,
    );

    const read = container.querySelector(
      '[data-tool-rule="inspire.pi.read"]',
    ) as HTMLElement;
    expect(read).not.toBeNull();
    expect(within(read).queryByText("Arguments")).not.toBeInTheDocument();
    expect(within(read).getByText("const one = 1;")).toBeInTheDocument();
    expect(within(read).getByText("41")).toHaveClass("tool-code__number");

    const custom = screen
      .getByText("custom_tool", { selector: ".card__tool-name" })
      .closest(".card") as HTMLElement;
    expect(within(custom).getByText("Arguments")).toBeInTheDocument();
    expect(within(custom).getByText("custom output")).toBeInTheDocument();
  });

  it("renders native read image content as a lazy card image", () => {
    const { container } = render(
      card(call("read", { path: "assets/pixel.png" }), {
        role: "toolResult",
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: "cG5n", mimeType: "image/png" },
        ],
        isError: false,
      }),
    );

    const image = screen.getByRole("img", { name: "assets/pixel.png" });
    expect(image).toHaveAttribute("src", "data:image/png;base64,cG5n");
    expect(container.querySelector(".tool-presentation")).toHaveAttribute(
      "data-tool-rule",
      "inspire.pi.read",
    );
  });

  it("renders a successful edit from Pi's persisted patch", () => {
    const patch = [
      "--- src/app.ts",
      "+++ src/app.ts",
      "@@ -1 +1 @@",
      "-const value = 1;",
      "+const value = 2;",
      "",
    ].join("\n");
    const { container } = render(
      card(
        call("edit", {
          path: "src/app.ts",
          edits: [{ oldText: "requested fragment", newText: "replacement" }],
        }),
        result("Successfully replaced 1 block(s) in src/app.ts.", { patch }),
      ),
    );

    expect(screen.getByText("Applied changes")).toBeInTheDocument();
    expect(container.querySelector(".diff__lines")).not.toBeNull();
    expect(container.querySelectorAll(".diff__line--del")).toHaveLength(1);
    expect(container.querySelectorAll(".diff__line--add")).toHaveLength(1);
    expect(screen.queryByText("Requested replacement")).not.toBeInTheDocument();
    expect(screen.queryByText("requested fragment")).not.toBeInTheDocument();
  });

  it("groups grep matches instead of exposing argument JSON", () => {
    const { container } = render(
      card(
        call("grep", {
          pattern: "needle",
          path: "src",
          glob: "*.ts",
          context: 1,
        }),
        result("a.ts-4- before\na.ts:5: needle here\na.ts-6- after"),
      ),
    );

    expect(container.querySelector(".tool-search-group")).not.toBeNull();
    expect(
      container.querySelector(".tool-search-group .resource-path__visible"),
    ).toHaveTextContent("a.ts");
    expect(
      container.querySelector(".tool-search-group__line-plane"),
    ).not.toBeNull();
    expect(screen.getByText("needle here")).toBeInTheDocument();
    expect(screen.getByText("5")).toHaveClass("tool-search-line__number");
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();
  });

  it("keeps complete resource actions behind one middle-truncation label", () => {
    const readPath =
      "docdoki/stages/archive/challenge-response-fold-pagination-2026-08-22.md";
    const editPath =
      "/home/wangzixiong/.pi/custom-extensions/pickup/test/workstream-announcement-records-2026-08-22.ts";
    const patch = [
      `--- ${editPath}`,
      `+++ ${editPath}`,
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    render(
      <>
        {card(
          call("read", { path: readPath }),
          result("contents"),
          "collapsed",
        )}
        {card(
          call("edit", {
            path: editPath,
            edits: [{ oldText: "before", newText: "after" }],
          }),
          result("Successfully replaced 1 block.", { patch }),
        )}
      </>,
    );

    for (const path of [readPath, editPath]) {
      const resource = screen.getByRole("button", { name: path });
      const label = resource.querySelector(".resource-path");
      expect(resource).toHaveAttribute("data-file-path", path);
      expect(resource).toHaveAttribute("title", `Preview ${path}`);
      expect(label?.querySelector(".resource-path__visible")).toHaveTextContent(
        path,
      );
    }
  });

  it("renders a configured custom rule through sanitized Markdown blocks", async () => {
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
        mappings: { custom_tool: "user.example.markdown" },
      }),
    );
    const { container } = render(
      card(
        call("custom_tool", { query: "Inspect evidence" }),
        result("## Finding\n\n**Supported** [unsafe](javascript:alert(1))"),
      ),
    );

    expect(container.querySelector(".tool-presentation")).toHaveAttribute(
      "data-tool-rule",
      "user.example.markdown",
    );
    expect(
      await screen.findByRole("heading", { name: "Finding" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Supported")).toBeInTheDocument();
    expect(screen.getByText("unsafe").closest("a")).not.toHaveAttribute("href");
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();
  });

  it("returns an incompatible selected native rule to the generic raw card", () => {
    render(
      card(
        call("edit", {
          path: "src/app.ts",
          edits: [{ oldText: "one", newText: "two" }],
        }),
        result("done", { diff: "-1 one\n+1 two" }),
      ),
    );

    expect(screen.getByText("Arguments")).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    const resource = screen.getByRole("button", { name: "src/app.ts" });
    expect(resource.querySelector(".resource-path__visible")).toHaveTextContent(
      "src/app.ts",
    );
  });
});
