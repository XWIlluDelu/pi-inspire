// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolPresentationConfigurationSchema } from "../../shared/tool-presentation-config";
import {
  CollapsedActivityStrip,
  ToolCard,
} from "../../src/components/transcript-cards";
import {
  type ChatMessage,
  type EventSlice,
  emptyEventSlice,
  reduceEvent,
  type ToolCallContent,
  type WireEvent,
} from "../../src/events";
import { configureToolPresentationRegistry } from "../../src/tool-presentations/registry";

const call: ToolCallContent = {
  type: "toolCall",
  id: "run-1",
  name: "bash",
  arguments: { command: "npm run build" },
};
const update = (text: string, truncated = false): WireEvent => ({
  type: "tool_execution_update",
  toolCallId: call.id,
  ...(text ? { outputPreview: { text, truncated } } : {}),
});
const reduce = (state: EventSlice, event: WireEvent) =>
  reduceEvent(state, new Set(), event).slice;
function running(toolCall = call) {
  return reduce(emptyEventSlice(), {
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
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
afterEach(() => configureToolPresentationRegistry());

describe("execution output previews", () => {
  it("keeps a declared tool's live output separate from its rule's final result", () => {
    configureToolPresentationRegistry(
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
    let state = reduce(
      running(toolCall),
      update("\u001b[32mLive progress\u001b[0m"),
    );
    const { rerender } = render(card(state, toolCall));
    expect(screen.getByText("Live progress")).toBeVisible();
    expect(screen.getByText("Output (live preview)")).toBeVisible();
    expect(screen.getByLabelText("running")).toBeVisible();
    expect(screen.queryByText("Final result")).not.toBeInTheDocument();

    state = reduce(state, {
      ...update(""),
      partialResult: { details: { progress: 90 } },
    });
    rerender(card(state, toolCall));
    expect(screen.queryByText("Live progress")).not.toBeInTheDocument();

    rerender(
      card(state, toolCall, { role: "toolResult", content: "Complete" }),
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
    const state = reduce(running(), {
      ...update(patch),
      partialResult: { details: { patch } },
    });
    const { container } = render(card(state, edit));
    expect(screen.getByText("Requested replacement")).toBeInTheDocument();
    expect(screen.queryByText("Applied changes")).not.toBeInTheDocument();
    expect(container.querySelector(".tool-terminal--live")?.textContent).toBe(
      patch,
    );
    expect(screen.getByLabelText("running")).toBeInTheDocument();
  });

  it("rejects late output while an execution failure is awaiting its final result", () => {
    const state = reduce(running(), update("working"));
    const ended = reduce(state, {
      type: "tool_execution_end",
      toolCallId: call.id,
      isError: true,
    });
    render(card(reduce(ended, update("late"))));
    expect(screen.queryByText("working")).not.toBeInTheDocument();
    expect(screen.queryByText("late")).not.toBeInTheDocument();
    expect(screen.getByText("Finalizing result…")).toBeVisible();
    expect(screen.getByLabelText("failed")).toBeVisible();
  });

  it("drops transient output on interrupted settlement without inventing success", () => {
    const state = reduce(reduce(running(), update("working")), {
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

  it("shows and copies a bounded, clearly labelled preview from a collapsed strip", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    let state = reduce(running(), update(`${"old".repeat(5_331)}latest`, true));
    const strip = (result?: ChatMessage) => (
      <CollapsedActivityStrip
        live
        activities={[
          {
            key: call.id,
            call,
            result,
            activity: state.tools[call.id],
          },
        ]}
      />
    );
    const { container, rerender } = render(strip());
    expect(container.querySelector(".tool-terminal--live")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /bash: running/ }));
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
    state = reduce(state, {
      type: "tool_execution_end",
      toolCallId: call.id,
      isError: true,
    });
    rerender(strip({ role: "toolResult", content: "aborted", isError: true }));
    expect(container.querySelector(".tool-terminal--live")).toBeNull();
    expect(
      screen.getByRole("button", { name: /bash: failed/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("aborted")).toBeInTheDocument();
  });
});
