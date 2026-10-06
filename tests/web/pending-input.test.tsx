// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pendingTextSummary } from "../../shared/pending-preview";
import { PendingQueueGroups } from "../../src/components/transcript-rows";
import { store } from "../../src/store";
import { useModalFocus } from "../../src/use-modal-focus";
import { pendingQueues } from "./pending-fixtures";

function PendingFocusModal() {
  const ref = useModalFocus<HTMLDivElement>();
  return (
    <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
      New dialog
    </div>
  );
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pending input visibility and actions", () => {
  it("keeps count-only image summaries visible until thumbnail handles are available", () => {
    const queue = pendingQueues(["", "Count-only caption", ""]);
    queue.steering[0]!.imageCount = 1;
    queue.steering[1]!.imageCount = 2;
    render(
      <PendingQueueGroups
        queue={queue}
        pendingAction={null}
        onClear={async () => true}
        onRecover={async () => true}
        getText={async () => "Count-only caption"}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("Image")).toBeVisible();
    expect(within(rows[0]!).queryByText("No text")).toBeNull();
    expect(within(rows[1]!).getByText("2 images")).toBeVisible();
    expect(within(rows[1]!).getByText("Count-only caption")).toBeVisible();
    expect(within(rows[2]!).getByText("No text")).toBeVisible();
  });

  it("previews retained images without changing Pending actions and releases them when consumed", async () => {
    const load = vi
      .spyOn(store, "loadAttachmentImage")
      .mockResolvedValue(new Blob(["image"]));
    const createUrl = vi
      .fn()
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second")
      .mockReturnValueOnce("blob:third");
    const revokeUrl = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: createUrl,
      revokeObjectURL: revokeUrl,
    });
    const queue = pendingQueues(["", "Compare these", ""]);
    queue.steering[0]!.imageCount = 1;
    queue.steering[0]!.imageAttachmentIds = ["first-image"];
    queue.steering[1]!.imageCount = 2;
    queue.steering[1]!.imageAttachmentIds = ["second-image", "third-image"];
    const onClear = vi.fn(async () => true);
    const onRecover = vi.fn(async () => true);
    const { rerender } = render(
      <PendingQueueGroups
        queue={queue}
        pendingAction={null}
        onClear={onClear}
        onRecover={onRecover}
        getText={async () => "Compare these"}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    const preview = await screen.findByRole("button", {
      name: "Preview Pending steer item 1 image 1",
    });
    expect(preview).toBeEnabled();
    expect(
      within(rows[0]!).getByRole("group", { name: "1 image" }),
    ).toBeVisible();
    expect(within(rows[0]!).queryByRole("button", { name: /Copy/ })).toBeNull();
    expect(within(rows[1]!).getByText("Compare these")).toBeVisible();
    expect(
      within(rows[1]!).getByRole("group", { name: "2 images" }),
    ).toBeVisible();
    expect(
      within(rows[1]!).getAllByRole("button", { name: /Preview Pending/ }),
    ).toHaveLength(2);
    expect(
      within(rows[1]!).getByRole("button", { name: "Copy steer item 2" }),
    ).toBeEnabled();
    expect(within(rows[2]!).getByText("No text")).toBeVisible();
    expect(within(rows[2]!).queryByRole("group")).toBeNull();
    fireEvent.click(preview);
    expect(screen.getByRole("dialog", { name: "Image preview" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Zoom image" })).toBeVisible();
    expect(onClear).not.toHaveBeenCalled();
    expect(onRecover).not.toHaveBeenCalled();
    queue.steering.shift(); // Consumption removes the owner, including its open viewer.
    queue.totalCount--;
    rerender(
      <PendingQueueGroups
        queue={queue}
        pendingAction={null}
        onClear={onClear}
        onRecover={onRecover}
        getText={async () => "Compare these"}
      />,
    );
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
    expect(revokeUrl).toHaveBeenCalledWith("blob:first");
    expect(load.mock.calls[0]![1].aborted).toBe(true);
  });

  it("preserves queue order and copies complete text rather than the truncated preview", async () => {
    const fullText = `steer first\nsecond line\nthird line\n${"x".repeat(600)}\nEXACT_END`;
    const allText = `1. ${fullText}\n2. steer second\n3. follow first\n4. follow second\n   continued`;
    const queue = pendingQueues(
      ["steer first", "steer second"],
      ["follow first", "follow second\ncontinued"],
      { revision: 7 },
    );
    Object.assign(queue.steering[0]!, pendingTextSummary(fullText));
    const getText = vi.fn(async (_revision: number, itemId?: string) =>
      itemId === undefined ? allText : fullText,
    );
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onClear = vi.fn(async () => true);
    const onRecover = vi.fn(async () => true);
    render(
      <PendingQueueGroups
        queue={queue}
        pendingAction={null}
        onClear={onClear}
        onRecover={onRecover}
        getText={getText}
      />,
    );
    const pending = screen.getByRole("region", { name: "Pending input" });
    const steering = screen.getByRole("region", { name: "Pending steer" });
    const followUp = screen.getByRole("region", { name: "Pending queue" });
    expect(
      within(steering)
        .getAllByRole("listitem")
        .map((item) => item.querySelector("pre")?.textContent),
    ).toEqual([
      "steer first\nsecond line\nthird line\n…\nEXACT_END",
      "steer second",
    ]);
    expect(
      within(followUp)
        .getAllByRole("listitem")
        .map((item) => item.querySelector("pre")?.textContent),
    ).toEqual(["follow first", "follow second\ncontinued"]);
    expect(within(steering).getAllByText("S")).toHaveLength(2);
    expect(within(followUp).getAllByText("Q")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: /pause|resume|delete|move/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(steering).getByRole("button", { name: "Copy steer item 1" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(fullText));
    expect(getText).toHaveBeenLastCalledWith(7, queue.steering[0]!.id);
    fireEvent.click(
      within(pending).getByRole("button", { name: "Copy all pending input" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(allText));
    expect(getText).toHaveBeenLastCalledWith(7);
    expect(onClear).not.toHaveBeenCalled();
    expect(onRecover).not.toHaveBeenCalled();
  });

  it("clears only after explicit confirmation and leaves cancelled clearing untouched", async () => {
    const onClear = vi.fn(async () => true);
    const onRecover = vi.fn(async () => true);
    render(
      <PendingQueueGroups
        queue={pendingQueues(["pending"], [], { revision: 7 })}
        pendingAction={null}
        onClear={onClear}
        onRecover={onRecover}
        getText={async () => "pending"}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clear all Pending input" }),
    );
    expect(onClear).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("region", { name: "Pending input" })).getByText(
        "Clear all?",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel clearing Pending input" }),
    );
    expect(onClear).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Clear all Pending input" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(onClear).toHaveBeenCalledOnce());
    expect(onRecover).not.toHaveBeenCalled();
  });

  it.each(["return", "new focus", "new modal"])(
    "returns explicit Pending focus only while it still owns focus: %s",
    async (action) => {
      let resolve!: (value: boolean) => void;
      const recovery = new Promise<boolean>((done) => {
        resolve = done;
      });
      const onRecover = vi.fn(() => recovery);
      render(
        <>
          <textarea aria-label="Message" />
          <button type="button">Another editor</button>
          <PendingQueueGroups
            queue={pendingQueues(["pending"])}
            pendingAction={null}
            onClear={async () => true}
            onRecover={onRecover}
            getText={async () => "pending"}
          />
        </>,
      );
      const button = screen.getByRole("button", {
        name: "Return all Pending input to composer",
      });
      button.focus();
      fireEvent.click(button);
      expect(onRecover).toHaveBeenCalledOnce();
      expect(screen.getByLabelText("Message")).not.toHaveFocus();
      if (action === "new focus")
        screen.getByRole("button", { name: "Another editor" }).focus();
      if (action === "new modal") render(<PendingFocusModal />);
      await act(async () => {
        resolve(true);
        await new Promise((done) => requestAnimationFrame(done));
      });
      if (action === "return")
        await waitFor(() =>
          expect(screen.getByLabelText("Message")).toHaveFocus(),
        );
      else expect(screen.getByLabelText("Message")).not.toHaveFocus();
    },
  );

  it("hides an empty Pending panel", () => {
    render(
      <PendingQueueGroups
        pendingAction={null}
        onClear={async () => true}
        onRecover={async () => true}
        getText={async () => ""}
        queue={pendingQueues()}
      />,
    );
    expect(
      screen.queryByRole("region", { name: "Pending input" }),
    ).not.toBeInTheDocument();
  });

  it("labels omitted rows and still copies the complete queue", async () => {
    const allText = "1. shown\n2. omitted first\n3. omitted second";
    const getText = vi.fn(async () => allText);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <PendingQueueGroups
        pendingAction={null}
        onClear={async () => true}
        onRecover={async () => true}
        getText={getText}
        queue={pendingQueues(["shown"], [], { totalCount: 3 })}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("2 more pending items not shown.")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Copy all pending input" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(allText),
    );
    expect(getText).toHaveBeenCalledExactlyOnceWith(0);
  });
});
