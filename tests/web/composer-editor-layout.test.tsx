// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerInput } from "../../src/components/ComposerInput";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("subtracts composer controls from the visual viewport when the keyboard leaves main layout tall", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 900 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 900);
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1200);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return Number.parseFloat(this.style.height) || 24;
    },
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const input = this.matches("textarea")
        ? this
        : this.querySelector<HTMLTextAreaElement>("textarea");
      const editor = Number.parseFloat(input?.style.height ?? "") || 24;
      const height = this.matches("main")
        ? 900
        : this.matches(".composer-dock")
          ? editor + 120
          : this.matches(".composer")
            ? editor + 80
            : editor;
      return new DOMRect(0, 0, 800, height);
    },
  );
  render(
    <main>
      <div className="composer-dock">
        <div className="composer">
          <ComposerInput
            value={"long wrapped text\n".repeat(60)}
            onChange={vi.fn()}
            commands={[]}
            label="Message"
            placeholder="Message Pi…"
          />
        </div>
      </div>
    </main>,
  );
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(input.style.height).toBe("360px");
  fireEvent.click(screen.getByRole("button", { name: "Expand editor" }));
  expect(input.style.height).toBe("716px");
  viewport.height = 400;
  viewport.dispatchEvent(new Event("resize"));
  await waitFor(() => expect(input.style.height).toBe("216px"));
  expect(screen.getByRole("main").getBoundingClientRect().height).toBe(900);
  expect(input.clientHeight + 120 + 64).toBeLessThanOrEqual(viewport.height);
  fireEvent.click(screen.getByRole("button", { name: "Collapse editor" }));
  expect(input.style.height).toBe("160px");
  expect(screen.getByRole("button", { name: "Expand editor" })).toBeVisible();
});
