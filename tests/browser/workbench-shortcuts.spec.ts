import { expect, test } from "@playwright/test";
import type { ModelOption } from "../../shared/contracts";
import { routeMockSnapshots } from "./support/mock-host";
import { openCommandPalette, pairAndOpen } from "./support/navigation";

// A service worker can bypass page.route. This fixture owns network model
// data, so keep those requests on the direct page routing lane in every engine.
test.use({ serviceWorkers: "block" });

const models: ModelOption[] = [
  {
    provider: "shortcut-fixture",
    id: "alpha",
    name: "Shortcut Alpha",
    reasoning: true,
  },
  {
    provider: "shortcut-fixture",
    id: "beta",
    name: "Shortcut Beta",
    reasoning: true,
  },
];

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
    // This tests shortcut ownership, not the model selection a previous test
    // left on the shared mock Host. Keep catalog, snapshots and control replies
    // in the same owned two-model cycle, including an explicit initial member.
    let selected = models[0]!;
    let thinkingLevel = "off";
    await routeMockSnapshots(page, {
      snapshot: (snapshot) => {
        if (snapshot.active?.sessionId === "mock-history")
          Object.assign(snapshot.active, {
            model: selected,
            availableModels: models,
            commonModels: models,
            thinkingLevel,
          });
      },
      bootstrap: (body) => {
        body.availableModels = models;
      },
    });
    await page.route("**/api/models**", (route) =>
      route.fulfill({ json: { models, commonModels: models } }),
    );
    // This fixture owns both directions to exercise shortcut delivery; native
    // Pi's RPC capability refusal is outside this routed UI scenario.
    await page.route("**/api/control/model-cycle", async (route) => {
      const body = route.request().postDataJSON();
      expect([1, -1]).toContain(body.direction);
      selected =
        models[
          (models.indexOf(selected) + body.direction + models.length) %
            models.length
        ]!;
      await route.fulfill({ json: { model: selected, thinkingLevel } });
    });
    await page.route("**/api/control/thinking", async (route) => {
      thinkingLevel = route.request().postDataJSON().level;
      await route.fulfill({ json: { ok: true } });
    });
    const changes: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/api\/control\/(model-cycle|thinking)$/.test(
          new URL(request.url()).pathname,
        )
      )
        changes.push(new URL(request.url()).pathname);
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairAndOpen(page);
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    const trigger = page.getByRole("button", { name: "Model", exact: true });
    await expect(trigger).toHaveText("Shortcut Alpha");
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
      if (key === "m") await expect(trigger).toHaveText("Shortcut Beta");
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
