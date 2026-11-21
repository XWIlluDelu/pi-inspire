// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "../../src/components/ModelSelector";
import { mockModelMenuLayout } from "./fixtures/model-menu-layout";

beforeEach(mockModelMenuLayout);

describe("model picker interaction", () => {
  it("shows an unavailable selection and refresh failure without claiming cached choices when discovery failed", async () => {
    render(
      <ModelSelector
        value={null}
        models={[]}
        recent={[]}
        onChange={vi.fn()}
        refreshModels={async () => {
          throw new Error("broken startup extension");
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "Model unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading models");
    expect(screen.queryByText("No models available yet.")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Could not refresh models",
      ),
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("cached choices");
    expect(screen.queryAllByRole("option")).toEqual([]);
  });

  it("keeps the keyboard selection by model identity when the catalog reorders", () => {
    const choices = [
      { provider: "fixture", id: "a", name: "Model Alpha" },
      { provider: "fixture", id: "b", name: "Model Beta" },
      { provider: "fixture", id: "c", name: "Model Gamma" },
    ];
    const onChange = vi.fn();
    const props = {
      value: choices[0]!,
      models: choices,
      recent: [],
      onChange,
    };
    const view = render(<ModelSelector {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(
      screen.getByRole("option", { name: /Model Alpha/, selected: true }),
    ).toBeVisible();
    const search = screen.getByRole("combobox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "model" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    view.rerender(
      <ModelSelector
        {...props}
        models={[
          ...choices,
          { provider: "fixture", id: "0", name: "Model Added" },
        ]}
        recent={[choices[2]!]}
      />,
    );
    expect(search).toHaveValue("model");
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("fixture", "b");
  });
});
