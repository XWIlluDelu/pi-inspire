// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolPresentationConfigurationSchema } from "../../shared/tool-presentation-config";
import { ToolCard } from "../../src/components/transcript-cards";
import type { ChatMessage, ToolCallContent } from "../../src/events";
import { store } from "../../src/store";
import { configureToolPresentationRegistry } from "../../src/tool-presentations/registry";

const call: ToolCallContent = {
  type: "toolCall",
  id: "extension-1",
  name: "extension_tool",
  arguments: {},
};
const image = { type: "image", mimeType: "image/png", data: "cG5n" };
function card(
  result?: ChatMessage,
  toolCall = call,
  visibility: "expanded" | "collapsed" = "expanded",
) {
  return (
    <ToolCard
      call={toolCall}
      result={result}
      activity={undefined}
      live={false}
      visibility={visibility}
    />
  );
}
afterEach(() => configureToolPresentationRegistry());

describe("generic tool result content", () => {
  it.each([
    { text: [] },
    { text: [{ type: "text", text: "Generated preview" }] },
  ])("shows raster images with and without text (%j)", ({ text }) => {
    render(
      card({
        role: "toolResult",
        content: [...text, image, { ...image, mimeType: "image/jpeg" }],
      }),
    );
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute("src", "data:image/png;base64,cG5n");
    expect(images[0]).toHaveAttribute("loading", "lazy");
    expect(images[0]).toHaveClass("tool-image-block__image");
    expect(images[1]).toHaveAttribute("src", "data:image/jpeg;base64,cG5n");
    if (text.length)
      expect(screen.getByText("Generated preview")).toBeInTheDocument();
    expect(screen.queryByText("No output")).not.toBeInTheDocument();
  });

  it.each([
    { ...image, mimeType: "image/svg+xml", data: "<svg onload=alert(1)>" },
    { ...image, mimeType: "text/html" },
    { ...image, data: "invalid<>" },
    { ...image, data: "" },
    { type: "image" },
  ])("does not trust unsupported or malformed images: %j", (part) => {
    const { container } = render(
      card({ role: "toolResult", content: [null, part] }),
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/Image unavailable/)).toBeInTheDocument();
    expect(container.querySelector("svg[onload]")).toBeNull();
  });

  it.each([
    { details: { matches: [{ path: "src/a.ts", line: 4 }] }, content: [] },
    { content: { matches: [{ path: "src/a.ts", line: 4 }] } },
    {
      content: [
        { type: "extensionData", matches: [{ path: "src/a.ts", line: 4 }] },
      ],
    },
  ])(
    "keeps structured-only results behind an inspectable disclosure: %j",
    async (payload) => {
      const { container } = render(card({ role: "toolResult", ...payload }));
      const disclosure = container.querySelector("details")!;
      expect(screen.getByText("Result details")).toBeInTheDocument();
      expect(disclosure).not.toHaveAttribute("open");
      expect(disclosure.querySelector("pre")).toBeNull();
      expect(screen.queryByText("No output")).not.toBeInTheDocument();
      disclosure.open = true;
      fireEvent(disclosure, new Event("toggle"));
      expect(await screen.findByText(/"matches"/)).toBeInTheDocument();
    },
  );

  it.each([undefined, "", [], {}])(
    "shows a genuinely empty result explicitly (%j)",
    (content) => {
      render(card({ role: "toolResult", content, details: {} }));
      expect(screen.getByText("No output")).toBeInTheDocument();
      expect(screen.queryByText("Result details")).not.toBeInTheDocument();
    },
  );

  it("retains text alongside optional result metadata without dumping it", () => {
    const { container } = render(
      card({
        role: "toolResult",
        content: "Useful output",
        details: { tokens: 1024 },
      }),
    );
    expect(screen.getByText("Useful output")).toBeInTheDocument();
    expect(container.querySelector("details pre")).toBeNull();
    expect(screen.queryByText(/1024/)).not.toBeInTheDocument();
  });
});

describe("generic resource summaries", () => {
  it.each(["path", "file", "file_path"])(
    "preserves a long %s resource identity and action",
    (key) => {
      const path = `src/${"long-directory/".repeat(12)}important-file.ts`;
      const open = vi.spyOn(store, "openResource").mockResolvedValue(undefined);
      render(
        card(undefined, { ...call, arguments: { [key]: path } }, "collapsed"),
      );
      const reference = screen.getByRole("button", { name: path });
      expect(reference).toHaveAttribute("data-file-path", path);
      expect(reference).toHaveAttribute("title", `Preview ${path}`);
      fireEvent.click(reference);
      expect(open).toHaveBeenCalledWith(path);
      expect(
        screen.getByRole("button", { name: "Expand extension_tool tool" }),
      ).toBeInTheDocument();
    },
  );

  it.each(["command", "query", "description"])(
    "does not guess a resource from a path-shaped %s",
    (key) => {
      const { container } = render(
        card(
          undefined,
          { ...call, arguments: { [key]: "src/not-a-resource.ts" } },
          "collapsed",
        ),
      );
      expect(screen.getByText("src/not-a-resource.ts")).toBeInTheDocument();
      expect(container.querySelector("button[data-file-path]")).toBeNull();
    },
  );
});

describe("declarative code options", () => {
  it.each([false, true, undefined])(
    "honors lineNumbers=%s and carries language metadata",
    (lineNumbers) => {
      configureToolPresentationRegistry(
        toolPresentationConfigurationSchema.parse({
          version: 1,
          mappings: { extension_tool: "user.code" },
          rules: {
            "user.code": {
              summary: [{ value: { literal: "Code" } }],
              blocks: [
                {
                  type: "code",
                  source: { path: "result.text" },
                  language: "typescript",
                  lineNumbers,
                },
              ],
            },
          },
        }),
      );
      const { container } = render(
        card({ role: "toolResult", content: "const one = 1;\nconst two = 2;" }),
      );
      expect(container.querySelectorAll(".tool-code__number")).toHaveLength(
        lineNumbers === false ? 0 : 2,
      );
      expect(container.querySelector(".tool-code")).toHaveAttribute(
        "data-language",
        "typescript",
      );
      expect(
        container.querySelector("code.language-typescript"),
      ).not.toBeNull();
      if (lineNumbers === false) {
        expect(container.querySelector(".tool-code__line")).toBeNull();
        expect(container.querySelector(".tool-code")?.textContent).toBe(
          "const one = 1;\nconst two = 2;",
        );
      }
    },
  );
});
