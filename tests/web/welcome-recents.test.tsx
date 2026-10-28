import { fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { Welcome } from "../../src/components/Welcome";
import { store } from "../../src/store";
import { saveNavigationDisclosure } from "../../src/workbench-session";
import { sessionPage } from "./fixtures/session-catalog";
import {
  bootstrapPayload,
  installFakeWebSocket,
  installFetch,
  sessionSummary,
} from "./helpers";

beforeEach(async () => {
  installFakeWebSocket();
  installFetch((url) => {
    if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload() };
    if (url.startsWith("/api/sessions"))
      return { body: sessionPage([sessionSummary()], 1) };
    return undefined;
  });
  await store.init("token");
  await store.loadSessions("");
  await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(1));
});

it("defaults to expanded and remembers both choices when returning to Welcome", () => {
  let view = render(<Welcome />);
  expect(
    screen.getByRole("button", { name: "Recent sessions" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /Previous work/ })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Recent sessions" }));
  view.unmount();

  view = render(<Welcome />);
  expect(
    screen.getByRole("button", { name: "Recent sessions" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: /Previous work/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Recent sessions" }));
  view.unmount();

  render(<Welcome />);
  expect(
    screen.getByRole("button", { name: "Recent sessions" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /Previous work/ })).toBeVisible();
});

it("restores a collapsed preference on the first commit without an expanded frame", () => {
  saveNavigationDisclosure("recentSessions", false);
  const committedStates: Array<string | null> = [];
  render(
    <Profiler
      id="welcome"
      onRender={() => {
        committedStates.push(
          screen
            .getByRole("button", { name: "Recent sessions" })
            .getAttribute("aria-expanded"),
        );
      }}
    >
      <Welcome />
    </Profiler>,
  );
  expect(committedStates.length).toBeGreaterThan(0);
  expect(committedStates).not.toContain("true");
  expect(screen.queryByRole("button", { name: /Previous work/ })).toBeNull();
});

it("keeps the disclosure usable when browser storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Storage unavailable", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage unavailable", "SecurityError");
  });
  render(<Welcome />);
  const toggle = screen.getByRole("button", { name: "Recent sessions" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
});
