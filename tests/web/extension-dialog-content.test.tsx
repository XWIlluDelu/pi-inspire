import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ExtensionDialogContent } from "../../src/components/ExtensionDialogContent";

afterEach(cleanup);
it("reuses controlled dialog content without a session store or transport", () => {
  const respond = vi.fn(),
    cancel = vi.fn();
  function Form({
    pending = false,
    error = null,
  }: {
    pending?: boolean;
    error?: string | null;
  }) {
    const [value, setValue] = useState("Original notes");
    return (
      <ExtensionDialogContent
        request={{
          sessionId: "example",
          id: "notes",
          method: "editor",
          title: "Task notes",
        }}
        value={value}
        pending={pending}
        error={error}
        onValueChange={setValue}
        onRespond={respond}
        onCancel={cancel}
      />
    );
  }
  const view = render(<Form />);
  fireEvent.change(screen.getByRole("textbox", { name: "Task notes" }), {
    target: { value: "Changed notes" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(respond).toHaveBeenCalledWith({ id: "notes", value: "Changed notes" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancel).toHaveBeenCalledOnce();
  view.rerender(<Form pending error="Please retry" />);
  expect(screen.getByRole("textbox")).toHaveValue("Changed notes");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Please retry");
  expect(screen.getByRole("alert")).toHaveAttribute("tabindex", "0");
  expect(screen.getByRole("textbox").closest("form")).toContainElement(
    screen.getByRole("alert"),
  );
});
