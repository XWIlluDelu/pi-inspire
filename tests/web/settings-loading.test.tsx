// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "../../src/App";
import {
  bootstrapPayload,
  installFakeWebSocket,
  installFetch,
} from "./helpers";

const deferred = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
});

vi.mock("../../src/components/Settings", async (importOriginal) => {
  await deferred.ready;
  return importOriginal();
});

it("keeps one animated shell and focus owner from loading through ready", async () => {
  installFakeWebSocket();
  installFetch((url) => {
    if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload() };
    if (url.startsWith("/api/snapshot"))
      return { body: { active: null, runState: "idle" } };
    return { body: {} };
  });
  render(<App />);
  const opener = await screen.findByRole("button", {
    name: "Settings",
  });
  opener.focus();
  fireEvent.click(opener);
  expect(await screen.findByText("Loading settings")).toBeInTheDocument();
  // Loading remains closable and restores the actual opener.
  fireEvent.keyDown(window, { key: "Escape" });
  await act(async () => {});
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  expect(opener).toHaveFocus();

  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  const overlay = dialog.parentElement;
  const close = screen.getByRole("button", { name: "Close settings" });
  expect(close).toHaveFocus();
  await act(async () => {
    deferred.release();
  });
  await screen.findByRole("navigation", { name: "Settings categories" });

  expect(screen.getByRole("dialog", { name: "Settings" })).toBe(dialog);
  expect(dialog.parentElement).toBe(overlay);
  expect(screen.getByRole("button", { name: "Close settings" })).toBe(close);
  expect(close).toHaveFocus();
  expect(screen.queryByText("Loading settings")).toBeNull();
  // Resolving the body must not register another modal owner.
  fireEvent.keyDown(window, { key: "Escape" });
  await act(async () => {});
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  expect(opener).toHaveFocus();
});
