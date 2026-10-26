// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import { PresentationAdapterSettings } from "../../src/components/PresentationAdapterSettings";
import { configurePresentationAdapters } from "../../src/presentation-adapters";
import { store } from "../../src/store";
import { deferred } from "./helpers";

afterEach(() => {
  configurePresentationAdapters(emptyToolPresentationConfiguration());
  vi.restoreAllMocks();
});

it("keeps an adapter save in its switch and reports failure without claiming success", async () => {
  configurePresentationAdapters(emptyToolPresentationConfiguration(), [
    { id: "example", name: "Example", enabled: true },
  ]);
  const pending = deferred<void>();
  vi.spyOn(store, "setPresentationAdapterEnabled").mockReturnValue(
    pending.promise,
  );
  const { container } = render(<PresentationAdapterSettings />);
  const toggle = screen.getByRole("switch", { name: "Example" });
  fireEvent.click(toggle);
  expect(store.setPresentationAdapterEnabled).toHaveBeenCalledWith(
    "example",
    false,
  );
  expect(toggle).toBeDisabled();
  expect(toggle).toBeChecked();
  expect(toggle).toHaveAttribute("aria-busy", "true");
  expect(container.querySelector(".settings__field-status")).toBeNull();
  await act(async () => pending.reject(new Error("Could not save adapter")));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not save adapter");
  expect(toggle).toBeEnabled();
  expect(toggle).toBeChecked();
  expect(toggle).toHaveAttribute("aria-busy", "false");
});
