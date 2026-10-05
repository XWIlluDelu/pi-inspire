// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomMessage } from "../../src/components/CustomMessage";
import { Transcript } from "../../src/components/Transcript";
import type { ChatMessage } from "../../src/events";
import { configureToolPresentationRegistry } from "../../src/tool-presentations/registry";
import {
  customMessageConfiguration,
  incomingIntercom,
  intercomBody,
} from "./fixtures/custom-message-presentation";

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

afterEach(() => {
  vi.restoreAllMocks();
  configureToolPresentationRegistry();
});

describe("extension context messages", () => {
  it("presents sender and exact Markdown body while preserving all original data lazily", async () => {
    configureToolPresentationRegistry(customMessageConfiguration);
    const message = incomingIntercom();
    const { container } = render(component(message));
    expect(
      screen.getByRole("article", { name: "Inspire: composer editing" }),
    ).toBeVisible();
    expect(screen.getByText("Intercom", { exact: true })).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "Composer review ready" }),
    ).toBeVisible();
    expect(
      screen.getByText("final paragraph", { selector: "strong" }),
    ).toBeVisible();
    expect(
      container.querySelector(
        ".custom-message__type, .custom-message__raw, time",
      ),
    ).toBeNull();
    expect(container).not.toHaveTextContent("intercom_message");
    expect(container).not.toHaveTextContent("To reply");
    expect(container).not.toHaveTextContent("seq 42");
    expect(container).not.toHaveTextContent("2030-");
    expect(container).not.toHaveTextContent("/home/reviewer");
    fireEvent.click(screen.getByText("Details", { selector: "summary" }));
    const raw = container.querySelector(".custom-message__raw")!.textContent!;
    expect(JSON.parse(raw)).toEqual({
      customType: message.customType,
      content: message.content,
      details: message.details,
    });
    fireEvent.click(screen.getByText("Details", { selector: "summary" }));
    expect(container.querySelector(".custom-message__raw")).toBeNull();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Copy inspire: composer editing block",
        }),
      );
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const copied = writeText.mock.calls[0]![0];
      expect(copied).toContain(message.content);
      expect(copied).toContain(JSON.stringify(message.details, null, 2));
      expect(copied).toContain(intercomBody);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("updates an already mounted message on a new bootstrap generation without losing Details state", async () => {
    const message = incomingIntercom();
    const { container } = render(component(message));
    expect(container.querySelector(".custom-message__type")).toBeNull();
    fireEvent.click(screen.getByText("Details", { selector: "summary" }));
    act(() => configureToolPresentationRegistry(customMessageConfiguration));
    expect(
      screen.getByRole("article", { name: "Inspire: composer editing" }),
    ).toBeVisible();
    expect(container.querySelector("details")).toHaveAttribute("open");
    expect(
      JSON.parse(container.querySelector(".custom-message__raw")!.textContent!)
        .content,
    ).toBe(message.content);
    act(() => configureToolPresentationRegistry());
    expect(screen.getByText("Intercom message")).toBeVisible();
    expect(container.querySelector("details")).toHaveAttribute("open");
  });

  it("retains the original unverified external attribution when a guard fails", async () => {
    configureToolPresentationRegistry(customMessageConfiguration);
    const message = incomingIntercom();
    message.content =
      "**From remote@other-host · unverified cross-machine**\n\nExternal body";
    message.details = {
      ...(message.details as object),
      message: {
        crossMachine: {
          origin: { name: "remote", machine: "other-host" },
          trust: "unverified",
        },
      },
    };
    const { container } = render(component(message));
    expect(
      await screen.findByText(
        "From remote@other-host · unverified cross-machine",
        { selector: "strong" },
      ),
    ).toBeVisible();
    expect(container.querySelector(".custom-message__source")).toBeNull();
    expect(screen.getByText("Intercom message")).toBeVisible();
  });

  it("keeps images and unknown blocks readable even for a configured type", async () => {
    configureToolPresentationRegistry(customMessageConfiguration);
    const message = incomingIntercom();
    message.content = [
      { type: "text", text: "**Original block**" },
      { type: "image", mimeType: "image/png", data: "cGljdHVyZQ==" },
      { type: "future", data: "Unrecognized payload" },
      "Primitive payload",
    ];
    const { container } = render(component(message));
    expect(
      await screen.findByText("Original block", { selector: "strong" }),
    ).toBeVisible();
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "data:image/png;base64,cGljdHVyZQ==",
    );
    expect(screen.getByText(/Unrecognized payload/)).toBeVisible();
    expect(screen.getByText("Primitive payload")).toBeVisible();
    expect(container.querySelector(".custom-message__source")).toBeNull();
  });

  it("renders Markdown directly, without tool state or empty details", async () => {
    const { container } = render(component(base));
    expect(
      await screen.findByRole("heading", { name: "Review" }),
    ).toBeVisible();
    expect(screen.getByText("extension", { selector: "strong" })).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Review report")).toBeVisible();
    expect(screen.queryByText("review_report")).toBeNull();
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
    expect(
      JSON.parse(container.querySelector(".custom-message__raw")!.textContent!),
    ).toEqual({
      customType: "review_report",
      details: { source: "peer", count: 2 },
    });
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
