import { expect, test } from "@playwright/test";
import { openCommandPalette, pairAndOpen } from "./support/navigation";

for (const platform of ["MacIntel", "Win32"]) {
  test(`model shortcuts preserve native text and match platform hints (${platform})`, {
    tag: "@cross-browser",
  }, async ({ page }) => {
    await page.addInitScript(
      (value) =>
        Object.defineProperty(navigator, "platform", {
          configurable: true,
          value,
        }),
      platform,
    );
    const changes: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/api\/control\/(model|thinking)$/.test(
          new URL(request.url()).pathname,
        )
      )
        changes.push(new URL(request.url()).pathname);
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairAndOpen(page);
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    const trigger = page.getByRole("button", { name: "Model", exact: true });
    const before = await trigger.textContent();
    await draft.fill("preserve ");
    expect(
      await draft.evaluate((target) =>
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "∏",
            code: "KeyP",
            altKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      ),
    ).toBe(true);
    await page.keyboard.insertText("∏");
    await expect(draft).toHaveValue("preserve ∏");
    expect(changes).toEqual([]);

    const mac = platform === "MacIntel";
    const modifiers = mac
      ? { ctrlKey: true, metaKey: true }
      : { altKey: true, shiftKey: true };
    for (const [key, count] of [
      ["m", 1],
      ["p", 2],
      ["r", 3],
    ] as const) {
      expect(
        await draft.evaluate(
          (target, init) =>
            target.dispatchEvent(
              new KeyboardEvent("keydown", {
                ...init,
                bubbles: true,
                cancelable: true,
              }),
            ),
          { key, ...modifiers },
        ),
      ).toBe(false);
      await expect.poll(() => changes.length).toBe(count);
      if (key === "m") await expect(trigger).not.toHaveText(before!);
      if (key === "p") await expect(trigger).toHaveText(before!);
    }
    await expect(draft).toHaveValue("preserve ∏");
    const palette = await openCommandPalette(page);
    await palette
      .getByRole("combobox", { name: "Filter commands" })
      .fill("Next model");
    await expect(
      palette.getByRole("option", { name: /Next model/ }),
    ).toContainText(mac ? "Ctrl+⌘+M" : "Alt+Shift+M");
  });
}
