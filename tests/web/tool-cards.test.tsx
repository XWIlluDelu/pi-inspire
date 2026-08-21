// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCard } from "../../src/components/transcript-cards";
import type { ChatMessage, ToolCallContent } from "../../src/events";

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

function card(toolCall: ToolCallContent, toolResult?: ChatMessage) {
  return (
    <ToolCard
      call={toolCall}
      result={toolResult}
      activity={undefined}
      live={false}
      visibility="expanded"
    />
  );
}

describe("native Pi tool cards", () => {
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
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("needle here")).toBeInTheDocument();
    expect(screen.getByText("5")).toHaveClass("tool-search-line__number");
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
  });
});
