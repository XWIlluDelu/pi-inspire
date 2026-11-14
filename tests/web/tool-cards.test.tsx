// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolCard } from "../../src/components/transcript-cards";
import type { ChatMessage, ToolCallContent } from "../../src/events";
import { configurePresentationAdapters } from "../../src/presentation-adapters";
import { store } from "../../src/store";

function call(name: string, args: Record<string, unknown>): ToolCallContent {
  return { type: "toolCall", id: `${name}-1`, name, arguments: args };
}

afterEach(() => configurePresentationAdapters());

function card(
  toolCall: ToolCallContent,
  result?: ChatMessage,
  visibility: "expanded" | "collapsed" = "expanded",
) {
  return <ToolCard call={toolCall} result={result} visibility={visibility} />;
}

describe("generic tool fallback", () => {
  it("uses generic child calls when the mapped CodeMode rule is absent", () => {
    configurePresentationAdapters({
      version: 1,
      rules: {},
      mappings: { codemode: "user.missing" },
    });
    render(
      card(call("codemode", { code: 'text("checked");' }), {
        role: "toolResult",
        content: "Script completed\nactual result",
        __inspireCalls: {
          source: "codemode",
          complete: true,
          calls: [{ key: "codemode:0", name: "read", status: "ok" }],
        },
      }),
    );
    expect(screen.getByRole("group", { name: "Child calls" })).toBeVisible();
    expect(
      screen.getByRole("group", { name: "Result text" }),
    ).toHaveTextContent("Script completed actual result");
  });
  it("keeps an unknown tool's live partial arguments directly visible", () => {
    const partial: ToolCallContent = {
      ...call("custom_tool", { prompt: "incoming argument text" }),
      __inspireToolCall: {
        phase: "streaming",
        characters: 40,
        truncated: false,
      },
    };
    render(
      <ToolCard
        call={partial}
        result={undefined}
        activity={undefined}
        live
        visibility="expanded"
      />,
    );
    expect(screen.getByText(/incoming argument text/)).toBeVisible();
  });

  it("opens or reveals the full file argument without treating a command as a path", () => {
    const path = `src/${"long-directory/".repeat(12)}important-file.ts`;
    const command = "src/not-a-resource.ts";
    const open = vi.spyOn(store, "openResource").mockResolvedValue(undefined);
    const reveal = vi
      .spyOn(store, "showInFileManager")
      .mockResolvedValue(undefined);
    const { rerender } = render(
      card(call("extension_tool", { file_path: path }), undefined, "collapsed"),
    );
    const reference = screen.getByRole("button", { name: path });
    fireEvent.click(reference);
    fireEvent.click(reference, { ctrlKey: true });
    fireEvent.click(reference, { metaKey: true });
    expect(open).toHaveBeenCalledExactlyOnceWith(path);
    expect(reveal.mock.calls).toEqual([[path], [path]]);

    rerender(card(call("extension_tool", { command }), undefined, "collapsed"));
    expect(screen.getByText(command)).toBeVisible();
    expect(screen.queryByRole("button", { name: command })).toBeNull();
  });
});
