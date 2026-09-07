// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomMessage } from "../../src/components/CustomMessage";
import { Transcript } from "../../src/components/Transcript";
import type { ChatMessage } from "../../src/events";

const base: ChatMessage = {
  role: "custom",
  customType: "review_report",
  display: true,
  content: "## Review\n\nAn **extension** message.\n\n- first\n- second",
};
const component = (message: ChatMessage) => (
  <CustomMessage
    message={message}
    sessionId=""
    viewId=""
    projectionKey="test"
  />
);

afterEach(() => vi.restoreAllMocks());

describe("extension context messages", () => {
  it("renders Markdown directly, without tool state or empty details", async () => {
    const { container } = render(component(base));
    expect(
      await screen.findByRole("heading", { name: "Review" }),
    ).toBeVisible();
    expect(screen.getByText("extension", { selector: "strong" })).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("review_report")).toBeVisible();
    expect(container.querySelector(".card, .card__status, details")).toBeNull();
    expect(screen.queryByText("Content")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy review report block" }),
    ).toBeInTheDocument();
  });

  it("only mounts optional structured details when opened", () => {
    const { container, rerender } = render(
      component({ ...base, details: { source: "peer", count: 2 } }),
    );
    const details = container.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(screen.queryByText(/"source"/)).not.toBeInTheDocument();
    fireEvent.click(within(details).getByText("Details"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByText(/"source": "peer"/)).toBeVisible();
    rerender(component({ ...base, details: null }));
    expect(container.querySelector("details")).toBeNull();
    rerender(component({ ...base, details: false }));
    expect(container.querySelector("details")).not.toBeNull();
  });

  it("does not render context-only messages", () => {
    const { container } = render(component({ ...base, display: false }));
    expect(container).toBeEmptyDOMElement();
  });

  it("supports text and inline image blocks and keeps unrecognized data inspectable", async () => {
    const { container, rerender } = render(
      component({
        ...base,
        content: [
          { type: "text", text: "**Before**" },
          { type: "image", mimeType: "image/png", data: "cGljdHVyZQ==" },
          { type: "text", text: "After" },
        ],
      }),
    );
    expect(
      await screen.findByText("Before", { selector: "strong" }),
    ).toBeVisible();
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "data:image/png;base64,cGljdHVyZQ==",
    );
    expect(screen.getByText("After")).toBeVisible();
    rerender(component({ ...base, content: { unknown: "payload" } }));
    expect(screen.getByText(/"unknown": "payload"/)).toBeVisible();
  });

  it("does not turn extension Markdown HTML into executable markup", async () => {
    const { container } = render(
      component({
        ...base,
        content:
          '# Safe\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">',
      }),
    );
    expect(await screen.findByRole("heading", { name: "Safe" })).toBeVisible();
    expect(container.querySelector("script, [onerror]")).toBeNull();
  });

  it("searches settled extension content in All without attributing it to User or Model", async () => {
    render(
      <Transcript
        sessionId="custom-search"
        messages={[base]}
        streaming={false}
        thinkingVisibility="hidden"
        toolVisibility="hidden"
        activityFoldVisibility="collapsed"
      />,
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search conversation" }),
      { target: { value: "extension" } },
    );
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 match");
    for (const scope of ["User", "Model"]) {
      fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
      fireEvent.click(screen.getByRole("option", { name: scope }));
      expect(
        screen.getByLabelText("Transcript search matches"),
      ).toHaveTextContent("No matches");
    }
    expect(
      await screen.findByText("extension", { selector: "strong" }),
    ).toBeVisible();
  });
});
