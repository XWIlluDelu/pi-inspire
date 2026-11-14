// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { Transcript } from "../../src/components/Transcript";

it("keeps custom details open when its live message adopts a durable timestamp", () => {
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
  fireEvent(details, new Event("toggle"));
  expect(details.querySelector("pre")).toHaveTextContent('"source": "peer"');
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
  expect(details).toHaveAttribute("open");
  expect(container.querySelectorAll(".custom-message")).toHaveLength(1);
  expect(screen.getByText("owned once")).toBeVisible();
});
