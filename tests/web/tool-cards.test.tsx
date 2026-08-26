// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toolPresentationConfigurationSchema } from "../../shared/tool-presentation-config";
import { ResourcePathLabel } from "../../src/components/ResourcePathLabel";
import { ToolCard } from "../../src/components/transcript-cards";
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
    expect(
      container.querySelector(".tool-search-group .resource-path__visible"),
    ).toHaveTextContent("a.ts");
    expect(screen.getByText("needle here")).toBeInTheDocument();
    expect(screen.getByText("5")).toHaveClass("tool-search-line__number");
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();
  });

  it("marks grammar and resource summary segments for stable truncation", () => {
    const { container } = render(
      card(
        call("grep", { pattern: "needle", path: "/a/very/long/path" }),
        result("No matches found"),
        "collapsed",
      ),
    );

    const summaryParts = container.querySelectorAll(".tool-summary__part");
    expect(summaryParts[1]).toHaveClass("tool-summary__part--subdued");
    expect(summaryParts[2]).toHaveClass("tool-summary__part--resource");
  });

  it("keeps the complete value on adaptive resource path labels", () => {
    const paths = [
      "server/app.ts",
      "src/components/Nav.tsx",
      "C:\\workspace\\src\\really-long-file-name.ts",
      "file:///home/user/folder/report.json",
      "/home/user/directory/",
    ];
    const { container } = render(
      <>
        {paths.map((path) => (
          <ResourcePathLabel key={path} path={path} />
        ))}
      </>,
    );

    for (const [index, path] of paths.entries()) {
      const label = container.querySelectorAll(".resource-path")[index];
      expect(label).toHaveAttribute("title", path);
      expect(label.querySelector(".visually-hidden")).toHaveTextContent(path);
      expect(label.querySelector(".resource-path__visible")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(label.querySelector(".resource-path__visible")).toHaveTextContent(
        path,
      );
    }
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
    const { container } = render(
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
    expect(container.querySelector(".tool-block__heading")).toContainElement(
      container.querySelector(".tool-block__path"),
    );
  });

  it("renders a configured custom rule through sanitized Markdown blocks", () => {
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
      screen.getByRole("heading", { name: "Finding" }),
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
