// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingQueueGroups } from "../../src/components/transcript-rows";
import { useModalFocus } from "../../src/use-modal-focus";
import { deferred } from "./helpers";
import { pendingQueues } from "./pending-fixtures";

function PendingFocusModal() {
  const ref = useModalFocus<HTMLDivElement>();
  return (
    <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
      New dialog
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pending input visibility and actions", () => {
  it("keeps count-only image summaries visible until thumbnail handles are available", () => {
    const queue = pendingQueues(["", "Count-only caption", ""], [], {
      totalCount: 5,
    });
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
    expect(rows).toHaveLength(3);
    expect(screen.getByText("5 pending items")).toBeVisible();
    expect(screen.getByText("2 more pending items not shown.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Copy all pending input" }),
    ).toBeEnabled();
  });

  it.each(["new focus", "new modal"])(
    "does not steal focus from %s after delayed Pending recovery",
    async (action) => {
      const recovery = deferred<boolean>();
      render(
        <>
          <textarea aria-label="Message" />
          <button type="button">Another editor</button>
          <PendingQueueGroups
            queue={pendingQueues(["pending"])}
            pendingAction={null}
            onClear={async () => true}
            onRecover={() => recovery.promise}
            getText={async () => "pending"}
          />
        </>,
      );
      const button = screen.getByRole("button", {
        name: "Return all Pending input to composer",
      });
      button.focus();
      fireEvent.click(button);
      if (action === "new modal") render(<PendingFocusModal />);
      const owner =
        action === "new modal"
          ? screen.getByRole("dialog")
          : screen.getByRole("button", { name: "Another editor" });
      if (action === "new focus") owner.focus();
      await act(async () => {
        recovery.resolve(true);
        await new Promise((done) => requestAnimationFrame(done));
      });
      expect(owner).toHaveFocus();
    },
  );
});
