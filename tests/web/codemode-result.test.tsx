// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CodeModeResult } from "../../src/components/CodeModeResult";
import type { ChatMessage } from "../../src/events";

function message(...text: string[]): ChatMessage {
  return {
    role: "toolResult",
    content: text.map((text) => ({ type: "text", text })),
  };
}

it("reads JSON hierarchy and multiline strings without controls, field guessing or numeric rounding", () => {
  const result = message(
    "Script completed\nWall time 3.5 seconds\nOutput:\n",
    "Successfully updated the file.",
    '{"i":1,"result":{"output":"first line\\nsecond line","literal":"\\\\n","truncated":false,"exit_code":0,"full_output_path":"/not-an-authorized-target"},"identifier":9007199254740993}',
  );
  const view = render(
    <CodeModeResult result={result} renderImage={() => null} />,
  );
  expect(
    [...view.container.querySelectorAll("pre")].map((pre) => pre.textContent),
  ).toEqual([
    "Successfully updated the file.",
    `{
  "i": 1,
  "result": {
    "output": "first line
      second line",
    "literal": "\\\\n",
    "truncated": false,
    "exit_code": 0,
    "full_output_path": "/not-an-authorized-target"
  },
  "identifier": 9007199254740993
}`,
  ]);
  expect(screen.queryByText(/Script completed/)).not.toBeInTheDocument();
  expect(view.container.querySelector("button, details, a")).toBeNull();
});

it("retains partial output and errors while keeping banner-like user text literal", () => {
  const output = [
    "Script completed\nWall time 1 seconds\nOutput:\nThis is user output.",
    "{not JSON}\n<script>alert(1)</script>",
    "Script error:\nOperation failed",
  ];
  const view = render(
    <CodeModeResult
      result={{
        ...message("Script failed\nWall time 2 seconds\nOutput:\n", ...output),
        isError: true,
      }}
      renderImage={() => null}
    />,
  );
  expect(
    [...view.container.querySelectorAll("pre")].map((pre) => pre.textContent),
  ).toEqual(output);
  expect(view.container.querySelector("script")).toBeNull();
});

it("shows all received text and array entries without collection paging or text reveal", () => {
  const lines = Array.from(
    { length: 6_000 },
    (_, index) => `line ${index}`,
  ).join("\n");
  const result = message(
    JSON.stringify({
      lines,
      values: [
        null,
        false,
        "",
        {},
        [],
        ...Array.from({ length: 50 }, (_, i) => i),
      ],
    }),
  );
  const view = render(
    <CodeModeResult result={result} renderImage={() => null} />,
  );
  const output = view.container.querySelector("pre")!.textContent!;
  expect(output).toContain("line 5999");
  expect(output).toContain('null,\n    false,\n    "",\n    {},\n    []');
  expect(output).toContain("49\n  ]");
  expect(view.container.querySelector("button, details")).toBeNull();
});

it("keeps interleaved images on their original persisted part reference after removing the banner", () => {
  const result: ChatMessage = {
    role: "toolResult",
    __inspireMessageIndex: 17,
    content: [
      {
        type: "text",
        text: "Script completed\nWall time 1 seconds\nOutput:\n",
      },
      { type: "text", text: '{"answer":42}' },
      { type: "image", data: "cG5n", mimeType: "image/png" },
      { type: "text", text: "After the image" },
    ],
  };
  const renderImage = vi.fn((block) => (
    <span data-testid="image">{block.reference}</span>
  ));
  const view = render(
    <CodeModeResult result={result} renderImage={renderImage} />,
  );
  const image = screen.getByTestId("image");
  expect(image).toHaveTextContent("pi-embedded://17/2");
  expect(
    view.container.querySelector("pre")!.compareDocumentPosition(image) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    image.compareDocumentPosition(screen.getByText("After the image")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
