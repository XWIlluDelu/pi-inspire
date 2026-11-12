// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomMessage } from "../../src/components/CustomMessage";
import { Transcript } from "../../src/components/Transcript";
import type { ChatMessage } from "../../src/events";
import { configureToolPresentationRegistry } from "../../src/tool-presentations/registry";
import {
  customMessageConfiguration,
  incomingRelay,
} from "./fixtures/custom-message-presentation";
import { openTranscriptSearch } from "./helpers";

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  configureToolPresentationRegistry();
});

describe("extension context messages", () => {
  it("updates an already mounted message on a new bootstrap generation without losing Details state", async () => {
    const message = incomingRelay();
    const { container } = render(component(message));
    fireEvent.click(screen.getByText("Details"));
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
    expect(screen.getByText("Relay message")).toBeVisible();
    expect(container.querySelector("details")).toHaveAttribute("open");
  });

  it("retains the original unverified external attribution when a guard fails", async () => {
    configureToolPresentationRegistry(customMessageConfiguration);
    const message = incomingRelay();
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
    render(component(message));
    expect(
      await screen.findByText(
        "From remote@other-host · unverified cross-machine",
        { selector: "strong" },
      ),
    ).toBeVisible();
    expect(screen.getByText("Relay message")).toBeVisible();
  });

  it("falls back to the original mixed blocks when a projection cannot apply", async () => {
    configureToolPresentationRegistry(customMessageConfiguration);
    const message = incomingRelay();
    message.content = [
      { type: "text", text: "**Original block**" },
      { type: "image", mimeType: "image/png", data: "cGljdHVyZQ==" },
      { type: "future", data: "Unrecognized payload" },
      "Primitive payload",
      { type: "text", text: "After" },
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
    expect(screen.getByText("After")).toBeVisible();
  });

  it("does not render context-only messages", () => {
    const { container } = render(component({ ...base, display: false }));
    expect(container).toBeEmptyDOMElement();
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
    fireEvent.change(openTranscriptSearch(), {
      target: { value: "extension" },
    });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 match");
    for (const scope of ["User", "Model"]) {
      fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
      fireEvent.click(screen.getByRole("option", { name: scope }));
      expect(
        screen.getByLabelText("Transcript search matches"),
      ).toHaveTextContent("0 matches");
    }
    expect(
      await screen.findByText("extension", { selector: "strong" }),
    ).toBeVisible();
  });
});

it("keeps custom details open when its live message adopts a durable timestamp", () => {
  vi.useFakeTimers();
  const props = {
    streaming: true,
    thinkingVisibility: "dynamic" as const,
    toolVisibility: "dynamic" as const,
  };
  const started = {
    role: "custom",
    customType: "relay_message",
    content: "owned once",
    details: { source: "peer" },
    display: true,
    timestamp: 50,
    __inspireLiveId: "custom-live-owned",
    __inspireMessageId: "custom-owned:0",
    __inspireEntryId: "custom-owned",
  };
  const { container, rerender } = render(
    <Transcript messages={[started]} {...props} />,
  );
  const details = container.querySelector(".custom-message__details")!;
  fireEvent.click(within(details as HTMLElement).getByText("Details"));
  expect(details).toHaveAttribute("open");

  rerender(
    <Transcript
      messages={[
        {
          ...started,
          timestamp: 5_000,
          __inspireLiveId: undefined,
          __inspireSettled: undefined,
        },
      ]}
      {...props}
    />,
  );
  expect(container.querySelector(".custom-message__details")).toBe(details);
  act(() => vi.advanceTimersByTime(5_000));
  expect(details).toHaveAttribute("open");
  expect(container.querySelectorAll(".custom-message")).toHaveLength(1);
  expect(screen.getByText("owned once")).toBeVisible();
});
