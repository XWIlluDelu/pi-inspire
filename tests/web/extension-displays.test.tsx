// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExtensionDisplayDock } from "../../src/components/ExtensionDisplays";
import { Transcript } from "../../src/components/Transcript";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders attributable extension content and hides anonymous extension plumbing", () => {
  const { rerender, container } = render(
    <Transcript
      messages={[
        {
          role: "assistant",
          content: [
            {
              type: "custom",
              title: "Extension content",
              extensionName: "Web search",
              payload: { hidden: true },
            },
          ],
        },
      ]}
      streaming={false}
      thinkingVisibility="collapsed"
      toolVisibility="collapsed"
    />,
  );
  expect(screen.getByText("Web search")).toHaveClass("card__generic-title");
  expect(screen.queryByText("Extension content")).not.toBeInTheDocument();
  expect(screen.queryByText("custom")).not.toBeInTheDocument();

  rerender(
    <Transcript
      messages={[
        {
          role: "assistant",
          content: [
            null,
            "internal",
            7,
            { title: "Extension content" },
            { type: "CUSTOM" },
          ],
        },
      ]}
      streaming={false}
      thinkingVisibility="collapsed"
      toolVisibility="collapsed"
    />,
  );
  expect(screen.queryByText("Extension")).not.toBeInTheDocument();
  expect(container.querySelector(".card--generic")).toBeNull();
});
it("foregrounds placed widget text, copies it fully and retains attributable raw fallback", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const displays = [
    {
      id: "setWidget:plan",
      kind: "widget" as const,
      label: "plan",
      source: "extensions/plan.ts",
      placement: "aboveEditor" as const,
      lines: ["\u001b[32mone\u001b[0m", "two"],
    },
    {
      id: "setWidget:usage",
      kind: "widget" as const,
      label: "usage",
      source: "Pi extension",
      placement: "belowEditor" as const,
      lines: ["5h 37%"],
    },
    {
      id: "showPanel:build",
      kind: "raw" as const,
      label: "build",
      source: "extensions/build.ts",
      placement: "aboveEditor" as const,
      method: "showPanel",
      payload: { status: "passing" },
    },
  ];
  render(
    <>
      <Transcript
        messages={[]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="hidden"
        extensionDisplays={displays}
      />
      <ExtensionDisplayDock displays={displays} placement="aboveEditor" />
      <ExtensionDisplayDock displays={displays} placement="belowEditor" />
    </>,
  );
  const above = screen.getByRole("region", {
    name: "Extension content above composer",
  });
  const below = screen.getByRole("region", {
    name: "Extension content below composer",
  });
  expect(within(above).queryByText("plan")).toBeNull();
  expect(within(above).queryByText("extensions/plan.ts")).toBeNull();
  expect(
    within(above).getByRole("group", { name: "Extension widget" }),
  ).toBeInTheDocument();
  fireEvent.click(
    within(above).getByRole("button", { name: "Copy extension widget" }),
  );
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("one\ntwo"));
  const widgetText = above.querySelector(".extension-display__text");
  expect(widgetText).toHaveTextContent("one two");
  expect(widgetText?.textContent).not.toContain("\u001b[32m");
  expect(within(below).queryByText("usage")).toBeNull();
  expect(within(below).getByText("5h 37%")).toBeInTheDocument();
  const fallback = screen.getByRole("region", {
    name: "Extension display content",
  });
  expect(
    within(fallback).getByText("extensions/build.ts · build"),
  ).toBeInTheDocument();
  expect(within(fallback).queryByText("plan")).not.toBeInTheDocument();
  fireEvent.click(within(fallback).getByText("extensions/build.ts · build"));
  expect(within(fallback).getByText(/passing/)).toBeInTheDocument();
});
