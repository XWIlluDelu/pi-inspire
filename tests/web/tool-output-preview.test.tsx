// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
function running() {
  return reduce(emptyEventSlice(), {
    type: "tool_execution_start",
    toolCallId: call.id,
    toolName: call.name,
    args: call.arguments,
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
  it("retains Host-authored bounded tails, replaces cumulative previews, and clears empty replacements", () => {
    let state = reduce(running(), update("old output"));
    state = reduce(state, update("replacement"));
    expect(state.tools[call.id]?.outputPreview).toEqual({
      text: "replacement",
      truncated: false,
    });
    const projected = update("x".repeat(15_994) + "newest", true);
    state = reduce(state, projected);
    expect(state.tools[call.id]?.outputPreview).toBe(projected.outputPreview);
    expect(state.tools[call.id]?.outputPreview?.text).toHaveLength(16_000);
    expect(state.tools[call.id]?.outputPreview?.text.endsWith("newest")).toBe(
      true,
    );
    expect(state.tools[call.id]?.outputPreview?.truncated).toBe(true);
    state = reduce(
      state,
      update(
        Array.from({ length: 400 }, (_, i) => `line ${i + 100}`).join("\n"),
        true,
      ),
    );
    expect(state.tools[call.id]?.outputPreview?.text.split("\n")).toHaveLength(
      400,
    );
    expect(
      state.tools[call.id]?.outputPreview?.text.startsWith("line 100\n"),
    ).toBe(true);
    state = reduce(state, update(""));
    expect(state.tools[call.id]?.outputPreview).toBeUndefined();
    state = reduce(state, {
      ...update(""),
      partialResult: { details: { progress: 90 } },
    });
    expect(state.tools[call.id]?.outputPreview).toBeUndefined();
  });

  it.each(["bash", "powershell", "unknown_extension", "declared_extension"])(
    "renders %s live text separately from arguments and final content",
    (name) => {
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
      const toolCall = { ...call, name };
      let state = running();
      const { container, rerender } = render(card(state, toolCall));
      const shell = container.querySelector(".card");
      expect(screen.getByText("Running…")).toBeInTheDocument();
      state = reduce(state, update("Building modules…\n[140/260] working"));
      rerender(card(state, toolCall));
      expect(container.querySelector(".tool-terminal--live")).toHaveTextContent(
        "[140/260] working",
      );
      expect(screen.getByText("Output (live preview)")).toBeInTheDocument();
      expect(screen.getByLabelText("running")).toBeInTheDocument();
      expect(screen.queryByLabelText("finished")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: `Copy ${name} live output preview`,
        }),
      ).toBeInTheDocument();
      state = reduce(state, update("\u001b[32mReplacement progress\u001b[0m"));
      rerender(card(state, toolCall));
      expect(screen.queryByText(/140\/260/)).not.toBeInTheDocument();
      expect(container.querySelector(".tool-terminal--live")?.textContent).toBe(
        "Replacement progress",
      );
      rerender(
        card(state, toolCall, { role: "toolResult", content: "Final output" }),
      );
      expect(container.querySelector(".tool-terminal--live")).toBeNull();
      expect(screen.getByText("Final output")).toBeInTheDocument();
      expect(screen.getByLabelText("finished")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: `Copy ${name} tool block` }),
      ).toBeInTheDocument();
      expect(container.querySelector(".card")).toBe(shell);
    },
  );

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

  it.each([false, true])(
    "ends previews on execution end (error=%s) and rejects stale updates",
    (isError) => {
      const state = reduce(running(), update("working"));
      const { container, rerender } = render(card(state));
      const ended = reduce(state, {
        type: "tool_execution_end",
        toolCallId: call.id,
        isError,
      });
      expect(ended.tools[call.id]?.outputPreview).toBeUndefined();
      expect(reduce(ended, update("late"))).toBe(ended);
      rerender(card(ended));
      expect(container.querySelector(".tool-terminal--live")).toBeNull();
      expect(screen.getByText("Finalizing result…")).toBeInTheDocument();
      expect(
        screen.getByLabelText(isError ? "failed" : "finished"),
      ).toBeInTheDocument();
      rerender(
        card(ended, call, {
          role: "toolResult",
          content: isError ? "Command failed" : "Done",
          isError,
        }),
      );
      expect(
        screen.getByText(isError ? "Command failed" : "Done"),
      ).toBeInTheDocument();
    },
  );

  it.each(["aborted", "failed", "idle"])(
    "drops transient running output on authoritative %s without inventing success",
    (runState) => {
      let state = reduce(running(), update("working"));
      state = reduce(state, { type: "status", sessionStatus: { runState } });
      expect(state.tools[call.id]).toBeUndefined();
      const { container } = render(
        <ToolCard
          call={call}
          result={undefined}
          activity={state.tools[call.id]}
          live={false}
          visibility="expanded"
        />,
      );
      expect(container.querySelector(".tool-terminal--live")).toBeNull();
      expect(screen.getByText("No result recorded")).toBeInTheDocument();
      expect(screen.queryByLabelText("finished")).not.toBeInTheDocument();
    },
  );

  it("keeps updates from completing an adaptive card and does not materialize a collapsed preview", () => {
    vi.useFakeTimers();
    try {
      const state = reduce(running(), update("working"));
      const { container, rerender } = render(
        <ToolCard
          call={call}
          result={undefined}
          activity={state.tools[call.id]}
          live
          visibility="collapsed"
          dynamic
          dynamicActive
        />,
      );
      act(() => vi.advanceTimersByTime(10_000));
      expect(
        screen.getByRole("button", { name: "Collapse bash tool" }),
      ).toBeInTheDocument();
      expect(container.querySelector(".tool-terminal--live")).not.toBeNull();
      rerender(
        <ToolCard
          key="collapsed"
          call={call}
          result={undefined}
          activity={state.tools[call.id]}
          live
          visibility="collapsed"
        />,
      );
      expect(container.querySelector(".tool-terminal--live")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
            kind: "tool",
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
    expect(copied).not.toContain("\n\nResult\n\n");
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
