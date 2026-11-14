// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolPresentationConfigurationSchema } from "../../shared/tool-presentation-config";
import { ToolCard } from "../../src/components/transcript-cards";
import {
  type ChatMessage,
  type EventSlice,
  emptyEventSlice,
  reduceEvent,
  type ToolCallContent,
  type WireEvent,
} from "../../src/events";
import { configurePresentationAdapters } from "../../src/presentation-adapters";

const call: ToolCallContent = {
  type: "toolCall",
  id: "run-1",
  name: "bash",
  arguments: { command: "npm run build" },
};
const reduce = (state: EventSlice, event: WireEvent) =>
  reduceEvent(state, event).slice;
function progress(text: string, truncated = false): EventSlice {
  return reduce(emptyEventSlice(), {
    type: "tool_execution_update",
    toolActivity: {
      [call.id]: {
        id: call.id,
        name: call.name,
        phase: "running",
        ...(text ? { outputPreview: { text, truncated } } : {}),
      },
    },
  });
}
function card(state: EventSlice, toolCall = call, result?: ChatMessage) {
  return (
    <ToolCard
      call={toolCall}
      result={result}
      activity={state.tools[call.id]}
      live
      visibility="expanded"
    />
  );
}
afterEach(() => configurePresentationAdapters());

describe("execution output previews", () => {
  it("keeps a declared tool's live output separate from its rule's final result", () => {
    configurePresentationAdapters(
      toolPresentationConfigurationSchema.parse({
        version: 1,
        mappings: { declared_extension: "user.output" },
        rules: {
          "user.output": {
            summary: [{ value: { path: "args.command" } }],
            blocks: [
              {
                type: "text",
                label: "Final result",
                source: { path: "result.text" },
              },
            ],
          },
        },
      }),
    );
    const toolCall = { ...call, name: "declared_extension" };
    const { rerender } = render(
      card(progress("\u001b[32mLive progress\u001b[0m"), toolCall),
    );
    expect(screen.getByText("Live progress")).toBeVisible();
    expect(screen.getByText("Output (live preview)")).toBeVisible();
    expect(screen.getByLabelText("running")).toBeVisible();
    expect(screen.queryByText("Final result")).not.toBeInTheDocument();

    const withoutOutput = progress("");
    rerender(card(withoutOutput, toolCall));
    expect(screen.queryByText("Live progress")).not.toBeInTheDocument();

    rerender(
      card(withoutOutput, toolCall, {
        role: "toolResult",
        content: "Complete",
      }),
    );
    expect(screen.getByText("Final result")).toBeVisible();
    expect(screen.getByText("Complete")).toBeVisible();
    expect(screen.getByLabelText("finished")).toBeVisible();
  });

  it("never interprets an execution update as an applied edit patch", () => {
    const edit = {
      ...call,
      name: "edit",
      arguments: { path: "src/a.ts", oldText: "before", newText: "after" },
    };
    const patch = "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-before\n+after\n";
    const { container } = render(card(progress(patch), edit));
    expect(screen.getByText("Requested replacement")).toBeInTheDocument();
    expect(screen.queryByText("Applied changes")).not.toBeInTheDocument();
    expect(container.querySelector(".tool-terminal--live")?.textContent).toBe(
      patch,
    );
    expect(screen.getByLabelText("running")).toBeInTheDocument();
  });

  it("shows a failed execution before its final result arrives", () => {
    const ended = reduce(progress("working"), {
      type: "tool_execution_end",
      toolActivity: {
        [call.id]: { id: call.id, name: call.name, phase: "error" },
      },
    });
    render(card(ended));
    expect(screen.queryByText("working")).not.toBeInTheDocument();
    expect(screen.getByText("Finalizing result…")).toBeVisible();
    expect(screen.getByLabelText("failed")).toBeVisible();
  });

  it("drops transient output on interrupted settlement without inventing success", () => {
    const state = reduce(progress("working"), {
      type: "status",
      sessionStatus: { runState: "aborted" },
    });
    render(
      <ToolCard
        call={call}
        result={undefined}
        activity={state.tools[call.id]}
        live={false}
        visibility="expanded"
      />,
    );
    expect(screen.queryByText("working")).not.toBeInTheDocument();
    expect(screen.getByText("No result recorded")).toBeVisible();
    expect(screen.queryByLabelText("finished")).not.toBeInTheDocument();
  });

  it("shows and copies a bounded, clearly labelled preview from a collapsed tool", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const state = progress(`${"old".repeat(5_331)}latest`, true);
    const tool = (result?: ChatMessage) => (
      <ToolCard
        call={call}
        result={result}
        activity={state.tools[call.id]}
        live
        visibility="collapsed"
      />
    );
    const { container, rerender } = render(tool());
    expect(container.querySelector(".tool-terminal--live")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand bash tool" }));
    expect(
      screen.getByText("Showing latest output · preview truncated"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Copy bash live output preview" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("Output (live preview, truncated)");
    expect(copied.endsWith("latest")).toBe(true);
    rerender(tool({ role: "toolResult", content: "aborted", isError: true }));
    expect(container.querySelector(".tool-terminal--live")).toBeNull();
    expect(screen.getByLabelText("failed")).toBeInTheDocument();
    expect(screen.getByText("aborted")).toBeInTheDocument();
  });
});
