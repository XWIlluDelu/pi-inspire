// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { LegacyDualLineFold } from "../../src/components/legacy-activity-fold";

it("retains the legacy paired tracks, chronological colors and boundary controls", () => {
  const { container } = render(
    <LegacyDualLineFold
      visibility="collapsed"
      lifecycleActive
      closeRequested={false}
      telemetry={[
        { id: "think", kind: "thinking" },
        { id: "tool", kind: "tool", live: true },
      ]}
    >
      <button>Legacy activity content</button>
    </LegacyDualLineFold>,
  );
  const disclosure = screen.getByRole("button", {
    name: "Expand assistant activity",
  });
  expect(disclosure.querySelectorAll(".activity-fold__rail")).toHaveLength(2);
  for (const rail of disclosure.querySelectorAll(".activity-fold__rail")) {
    const segments = rail.querySelectorAll(".activity-fold__segment");
    expect(segments[0]).toHaveClass("activity-fold__segment--thinking");
    expect(segments[1]).toHaveClass(
      "activity-fold__segment--tool",
      "activity-fold__segment--live",
    );
  }
  fireEvent.click(disclosure);
  expect(
    screen.getByRole("button", { name: "Legacy activity content" }),
  ).toBeVisible();
  expect(container.querySelector(".activity-fold__glyph--down")).not.toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Collapse assistant activity from the lower boundary",
    }),
  );
  expect(
    screen.getByRole("button", { name: "Expand assistant activity" }),
  ).toHaveFocus();
});
