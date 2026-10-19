import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { encodeTerminalServerDataFrame } from "../../shared/terminal-contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { hostRequest } from "./support/host-request";
import { openMockSession, pairedPage } from "./support/navigation";
import { terminalWriteCommand } from "./support/terminal-command";
import { terminalMutationHeaders } from "./support/terminal-operations";
import { terminalTransportFixture } from "./support/terminal-transport";

test("a replacement terminal snapshot retires output still waiting in xterm's parser", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "inspire:terminal-ui-settings:v1",
      JSON.stringify({ screenReaderMode: true }),
    );
  });
  const [terminal] = await terminalTransportFixture(page, browserWorkspace, [
    "snapshot-replay",
  ]);
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.evaluate(() => {
    let terminalSocket: WebSocket | undefined;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url)).pathname === "/terminal")
          terminalSocket = this;
      }
    };
    // Deliver a replay boundary before xterm's asynchronous parser can drain
    // the retired output. Network/timer scheduling must not decide this race.
    window.addEventListener("inspire-test-terminal-replay", (event) => {
      if (!terminalSocket) throw new Error("Terminal socket is unavailable");
      for (const frame of (event as CustomEvent<Array<string | number[]>>)
        .detail) {
        terminalSocket.dispatchEvent(
          new MessageEvent("message", {
            data:
              typeof frame === "string" ? frame : Uint8Array.from(frame).buffer,
          }),
        );
      }
    });
  });
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Controlling", exact: true }),
  ).toBeVisible();
  await expect.poll(() => terminal!.resizes.length).toBeGreaterThan(0);
  terminal!.write("INITIAL_OUTPUT\r\n");
  await expect(
    page.locator(".terminal-view--active .xterm-accessibility-tree"),
  ).toContainText("INITIAL_OUTPUT");
  const descriptor = terminal!.descriptor;
  const frame = (kind: "output" | "snapshot", text: string) =>
    Array.from(
      encodeTerminalServerDataFrame(
        kind,
        descriptor.resizeRevision,
        descriptor.nextOutputOffset,
        Buffer.from(text),
      ),
    );
  await page.evaluate(
    (frames) =>
      window.dispatchEvent(
        new CustomEvent("inspire-test-terminal-replay", { detail: frames }),
      ),
    [
      frame("output", "RETIRED_OUTPUT\r\n"),
      JSON.stringify({
        type: "attached",
        terminal: descriptor,
        attachmentId: "replacement-attachment",
        writable: true,
        ownerToken: "replacement-owner",
        nextInputSequence: 1,
        replay: "snapshot",
      }),
      frame("snapshot", "CURRENT_SNAPSHOT"),
      JSON.stringify({
        type: "replay_complete",
        nextOutputOffset: descriptor.nextOutputOffset,
      }),
    ],
  );
  const output = page.locator(
    ".terminal-view--active .xterm-accessibility-tree",
  );
  await expect(output).toContainText("CURRENT_SNAPSHOT");
  await expect(output).not.toContainText("RETIRED_OUTPUT");
  terminal!.write("\r\nLIVE_TAIL");
  await expect(output).toContainText("LIVE_TAIL");
  await expect(
    page.getByRole("status", { name: "Controlling", exact: true }),
  ).toBeVisible();
});

test("project terminals survive browser detach and keep multiple tabs", {
  tag: "@cross-browser",
}, async ({ context, page, browserName }) => {
  // Real typing, replay, accessibility analysis, two clients and confirmed
  // serial PTY retirement share this budget; each operation keeps its deadline.
  test.setTimeout(60_000);
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.evaluate(() => {
    window.localStorage.setItem(
      "inspire:terminal-ui-settings:v1",
      JSON.stringify({ screenReaderMode: true }),
    );
  });
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();

  const emptyTerminal = page.locator(".terminal-empty");
  await emptyTerminal.getByRole("button", { name: "New terminal" }).click();
  const readTerminals = async () => {
    const response = await hostRequest(page).get(
      `/api/terminals?cwd=${encodeURIComponent(browserWorkspace)}`,
    );
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{
      terminals: Array<{ id: string; nextOutputOffset: number }>;
    }>;
  };
  const terminalInput = page.locator(".xterm-helper-textarea");
  await expect(terminalInput).toBeVisible();
  const firstCatalog = await readTerminals();
  const firstTerminal = firstCatalog.terminals[0]!;
  let terminalIds = [firstTerminal.id];
  try {
    await terminalInput.pressSequentially(
      terminalWriteCommand("INSPIRE_TERMINAL_E2E\n"),
    );
    await terminalInput.press("Enter");
    await expect
      .poll(async () => (await readTerminals()).terminals[0]!.nextOutputOffset)
      .toBeGreaterThan(firstTerminal.nextOutputOffset);
    const visibleTerminalOutput = page.locator(
      ".terminal-views__item:not([hidden]) .xterm-accessibility-tree",
    );
    if (browserName === "chromium") {
      // Only Chromium supports this headless read permission grant. Keep the
      // real paste check there; other engines still exercise native PTY input,
      // Unicode output, reload/replay, and control handoff without a shim.
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(page.url()).origin,
      });
      await page.evaluate(
        (command) => navigator.clipboard.writeText(command),
        terminalWriteCommand("终端✓\n"),
      );
      await page.getByLabel("Terminal actions", { exact: true }).click();
      await page.getByRole("button", { name: "Paste into terminal" }).click();
      await expect(
        page.locator(".terminal-pane details[data-terminal-menu][open]"),
      ).toHaveCount(0);
      await expect(terminalInput).toBeFocused();
    } else {
      await terminalInput.pressSequentially(terminalWriteCommand("终端✓\n"));
    }
    await terminalInput.press("Enter");
    await expect(visibleTerminalOutput).toContainText("终端✓");
    await terminalInput.pressSequentially(
      terminalWriteCommand("\u001b[?1049hINSPIRE_ALT_SCREEN"),
    );
    await terminalInput.press("Enter");
    await expect(visibleTerminalOutput).toContainText("INSPIRE_ALT_SCREEN");

    await page.getByRole("button", { name: "New terminal" }).click();
    await expect(page.locator(".terminal-tab__select")).toHaveCount(2);
    terminalIds = (await readTerminals()).terminals.map(({ id }) => id);
    const terminalAccessibility = await new AxeBuilder({ page })
      .include(".terminal-pane")
      .analyze();
    expect(terminalAccessibility.violations).toEqual([]);

    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await openMockSession(page, /Review extension event lifecycle/);
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(page.locator(".terminal-tab__select")).toHaveCount(2);
    expect((await readTerminals()).terminals.map(({ id }) => id)).toEqual(
      terminalIds,
    );

    await page.locator(`#terminal-tab-${terminalIds[0]}`).click();
    await expect(
      page.getByRole("status", { name: "Controlling", exact: true }),
    ).toBeVisible();
    const restoredInput = page.locator(
      ".terminal-views__item:not([hidden]) .xterm-helper-textarea",
    );
    await expect(
      page.locator(
        ".terminal-views__item:not([hidden]) .xterm-accessibility-tree",
      ),
    ).toContainText("INSPIRE_ALT_SCREEN");
    await restoredInput.pressSequentially(
      terminalWriteCommand("\u001b[?1049l"),
    );
    await restoredInput.press("Enter");

    const focusedPage = await context.newPage();
    const focusedUrl = new URL(page.url());
    focusedUrl.searchParams.set("terminal", terminalIds[0]!);
    focusedUrl.searchParams.set("terminalFocus", "1");
    await focusedPage.goto(focusedUrl.href);
    await expect(focusedPage.locator(".terminal-pane--focused")).toBeVisible();
    await expect(
      focusedPage.getByRole("status", { name: "View only", exact: true }),
    ).toBeVisible();
    await focusedPage.keyboard.press("ControlOrMeta+k");
    await focusedPage
      .getByRole("dialog", { name: "Command palette" })
      .getByLabel("Filter commands")
      .fill("take control");
    await focusedPage
      .getByRole("option", { name: /Take control of terminal/ })
      .click();
    await expect(
      focusedPage.getByRole("status", { name: "Controlling", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "View only", exact: true }),
    ).toBeVisible();
    await openMockSession(page, /Formula rendering and spectral analysis/);
    await expect(focusedPage.locator(".terminal-pane--focused")).toBeVisible();
    await expect(
      focusedPage.locator(`#terminal-tab-${terminalIds[0]}`),
    ).toHaveAttribute("aria-pressed", "true");
    await focusedPage.close();
  } finally {
    for (const terminalId of terminalIds) {
      const response = await hostRequest(page).delete(
        `/api/terminals/${encodeURIComponent(terminalId)}?force=1`,
        { headers: await terminalMutationHeaders(page) },
      );
      expect(response.ok()).toBe(true);
    }
  }
  await expect.poll(async () => (await readTerminals()).terminals).toEqual([]);
});

test.describe("terminal clipboard and focus ownership", () => {
  test.use({ serviceWorkers: "block" });

  for (const platform of ["Win32", "MacIntel"]) {
    test(platform +
      " preserves interrupt, native clipboard and palette focus toggle", {
      tag: "@cross-browser",
    }, async ({ page }) => {
      await page.addInitScript((platform) => {
        Object.defineProperty(navigator, "platform", {
          configurable: true,
          value: platform,
        });
      }, platform);
      const [terminal] = await terminalTransportFixture(
        page,
        browserWorkspace,
        ["clipboard-focus"],
      );
      await pairedPage(page);
      await openMockSession(page, /Review extension event lifecycle/);
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await expect(
        page.getByRole("status", { name: "Controlling", exact: true }),
      ).toBeVisible();
      const input = page.locator(
        ".terminal-view--active .xterm-helper-textarea",
      );
      await input.focus();
      await input.press("Control+c");
      await expect.poll(() => terminal!.inputs.join("")).toBe("\u0003");

      terminal!.write("COPY_ME\r\n");
      // Let the small output frame reach the real canvas renderer before drag.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const selectOutput = async () => {
        const box = await page
          .locator(".terminal-view--active .xterm-screen")
          .boundingBox();
        if (!box) throw new Error("Terminal screen is unavailable");
        const dimensions = terminal!.resizes.at(-1)!;
        const cell = box.width / dimensions.cols;
        const y = box.y + box.height / dimensions.rows / 2;
        await page.mouse.move(box.x + cell * 0.1, y);
        await page.mouse.down();
        await page.mouse.move(box.x + cell * 7, y);
        await page.mouse.up();
        await expect(
          page.getByRole("button", { name: "Copy terminal selection" }),
        ).toBeVisible();
      };
      await selectOutput();
      const beforeCopy = terminal!.inputs.join("");
      // A platform replay cannot operate the other OS's clipboard. Supply the
      // native clipboard event contract to real xterm with a controlled payload.
      expect(
        await input.evaluate((el, platform) => {
          const down = new KeyboardEvent("keydown", {
            key: "c",
            code: "KeyC",
            keyCode: 67,
            bubbles: true,
            cancelable: true,
            ctrlKey: platform !== "MacIntel",
            metaKey: platform === "MacIntel",
          });
          el.dispatchEvent(down);
          let text = "";
          const copy = new Event("copy", { bubbles: true, cancelable: true });
          Object.defineProperty(copy, "clipboardData", {
            value: {
              setData: (type: string, value: string) => {
                if (type === "text/plain") text = value;
              },
            },
          });
          el.dispatchEvent(copy);
          return { text, prevented: down.defaultPrevented };
        }, platform),
      ).toEqual({ text: "COPY_ME", prevented: false });
      expect(terminal!.inputs.join("")).toBe(beforeCopy);

      if (platform === "MacIntel") {
        await input.press("Control+c");
        await expect
          .poll(() => terminal!.inputs.join(""))
          .toBe(beforeCopy + "\u0003");
        await input.press("Control+v");
        await expect
          .poll(() => terminal!.inputs.join(""))
          .toBe(beforeCopy + "\u0003\u0016");
      }
      const beforePaste = terminal!.inputs.join("");
      const pastePrevented = await input.evaluate((el, platform) => {
        const down = new KeyboardEvent("keydown", {
          key: "v",
          code: "KeyV",
          keyCode: 86,
          bubbles: true,
          cancelable: true,
          ctrlKey: platform !== "MacIntel",
          metaKey: platform === "MacIntel",
        });
        el.dispatchEvent(down);
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", {
          value: {
            getData: (type: string) =>
              type === "text/plain" ? "PASTED_TEXT" : "",
          },
        });
        el.dispatchEvent(paste);
        return down.defaultPrevented;
      }, platform);
      expect(pastePrevented).toBe(false);
      await expect
        .poll(() => terminal!.inputs.join(""))
        .toBe(beforePaste + "PASTED_TEXT");

      const beforePalette = terminal!.inputs.join("");
      for (const focused of [true, false]) {
        await input.focus();
        await page.keyboard.press(
          platform === "MacIntel" ? "Meta+k" : "Control+k",
        );
        const filter = page.getByRole("combobox", { name: "Filter commands" });
        await filter.fill("Toggle terminal focus");
        await filter.press("Enter");
        await expect(
          page.getByRole("dialog", { name: "Command palette" }),
        ).toHaveCount(0);
        await expect(page.locator(".terminal-pane--focused")).toHaveCount(
          focused ? 1 : 0,
        );
      }
      expect(terminal!.inputs.join("")).toBe(beforePalette);
    });
  }
});

test.describe("international terminal keyboard input", () => {
  test.use({ serviceWorkers: "block" });

  for (const platform of ["Win32", "MacIntel"]) {
    test(platform + " preserves native characters and explicit tab chords", {
      tag: "@cross-browser",
    }, async ({ page }) => {
      await page.addInitScript((platform) => {
        Object.defineProperty(navigator, "platform", {
          configurable: true,
          value: platform,
        });
      }, platform);
      const ids = ["international-input", "international-second"];
      const [first] = await terminalTransportFixture(
        page,
        browserWorkspace,
        ids,
      );
      await pairedPage(page);
      await openMockSession(page, /Review extension event lifecycle/);
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await expect(
        page.getByRole("status", { name: "Controlling", exact: true }),
      ).toBeVisible();
      const input = page.locator(
        ".terminal-views__item:not([hidden]) .xterm-helper-textarea",
      );
      await input.focus();
      // Replay OS-layout events through real xterm. Synthetic keydown alone
      // cannot generate a native keypress, so supply both parts of that contract.
      const character = platform === "MacIntel" ? "|" : "[";
      expect(
        await input.evaluate(
          (el, { platform, character }) => {
            const native = {
              altKey: true,
              ctrlKey: platform === "Win32",
              modifierAltGraph: platform === "Win32",
            };
            const down = new KeyboardEvent("keydown", {
              ...native,
              key: character,
              code: platform === "MacIntel" ? "Digit7" : "Digit8",
              keyCode: platform === "MacIntel" ? 55 : 56,
              bubbles: true,
              cancelable: true,
            });
            el.dispatchEvent(down);
            el.dispatchEvent(
              new KeyboardEvent("keypress", {
                ...native,
                key: character,
                charCode: character.charCodeAt(0),
                keyCode: character.charCodeAt(0),
                bubbles: true,
                cancelable: true,
              }),
            );
            el.dispatchEvent(
              new KeyboardEvent("keyup", {
                ...native,
                key: character,
                bubbles: true,
              }),
            );
            return down.defaultPrevented;
          },
          { platform, character },
        ),
      ).toBe(false);
      await expect.poll(() => first!.inputs.join("")).toBe(character);
      await expect(page.locator("#terminal-tab-" + ids[0])).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      if (platform === "MacIntel") {
        await input.evaluate((el) => {
          const area = el as HTMLTextAreaElement;
          area.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Dead",
              code: "KeyE",
              keyCode: 69,
              altKey: true,
              bubbles: true,
            }),
          );
          area.dispatchEvent(
            new KeyboardEvent("keyup", {
              key: "Dead",
              code: "KeyE",
              altKey: true,
              bubbles: true,
            }),
          );
          area.value = "";
          area.dispatchEvent(
            new CompositionEvent("compositionstart", { bubbles: true }),
          );
          area.value = "é";
          area.dispatchEvent(
            new CompositionEvent("compositionupdate", {
              data: "é",
              bubbles: true,
            }),
          );
          area.dispatchEvent(
            new CompositionEvent("compositionend", {
              data: "é",
              bubbles: true,
            }),
          );
        });
        await expect.poll(() => first!.inputs.join("")).toBe("|é");
        await input.press("x");
        await expect.poll(() => first!.inputs.join("")).toBe("|éx");
      }
      const beforeTabs = first!.inputs.join("");
      await input.press("Alt+2");
      // On a real OS this chord is a shortcut only if key remains "2";
      // Playwright's physical chord reports the digit independent of layout.
      await expect(page.locator("#terminal-tab-" + ids[1])).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(first!.inputs.join("")).toBe(beforeTabs);
      await page.locator("#terminal-tab-" + ids[0]).click();
      await page
        .getByRole("button", { name: "Search terminal output", exact: true })
        .click();
      const search = page.getByRole("textbox", {
        name: "Search terminal output",
        exact: true,
      });
      expect(
        await search.evaluate((el) =>
          el.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "[",
              code: "Digit8",
              ctrlKey: true,
              altKey: true,
              modifierAltGraph: true,
              bubbles: true,
              cancelable: true,
            }),
          ),
        ),
      ).toBe(true);
      await search.press("Alt+2");
      await expect(page.locator("#terminal-tab-" + ids[0])).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(search).toBeFocused();

      if (platform === "MacIntel") {
        await search.press("Escape");
        await input.evaluate((el) =>
          el.setAttribute("data-keyboard-continuity", "same"),
        );
        const palette = page.getByRole("button", {
          name: "Open command palette",
          exact: true,
        });
        await palette.click();
        const commands = page.getByRole("dialog", { name: "Command palette" });
        await commands.getByLabel("Filter commands").fill("Terminal settings");
        await commands
          .getByRole("option", { name: /Terminal settings/ })
          .click();
        const settings = page.getByRole("dialog", {
          name: "Terminal settings",
          exact: true,
        });
        await settings
          .getByRole("button", { name: "Interaction", exact: true })
          .click();
        const option = settings.getByRole("switch", {
          name: "Use Option as Meta",
        });
        await expect(option).not.toBeChecked();
        await option.locator("..").click();
        await settings
          .getByRole("button", { name: "Close terminal settings" })
          .click();
        await expect(input).toHaveAttribute("data-keyboard-continuity", "same");
        await input.focus();
        await input.evaluate((el) => {
          el.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "¬",
              code: "KeyL",
              keyCode: 76,
              altKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
          el.dispatchEvent(
            new KeyboardEvent("keyup", {
              key: "¬",
              code: "KeyL",
              altKey: true,
              bubbles: true,
            }),
          );
        });
        await expect
          .poll(() => first!.inputs.join(""))
          .toBe(beforeTabs + "\u001bl");
      }
    });
  }
});

test("terminal search keeps IME keys native before ordinary match navigation", async ({
  page,
}) => {
  const [terminal] = await terminalTransportFixture(page, browserWorkspace, [
    "composition-search",
  ]);
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Controlling" }),
  ).toBeVisible();
  terminal!.write("测量一\r\n测量二\r\n");
  await page
    .getByRole("button", { name: "Search terminal output", exact: true })
    .click();
  const input = page.getByRole("textbox", {
    name: "Search terminal output",
    exact: true,
  });
  const result = page.locator(".terminal-search__count");
  await input.fill("测量");
  await expect(result).toHaveText("1/2");
  for (const ime of [
    { isComposing: true },
    { isComposing: false, keyCode: 229 },
  ]) {
    for (const key of ["Enter", "Escape"]) {
      expect(
        await input.evaluate(
          (el, init) =>
            el.dispatchEvent(
              new KeyboardEvent("keydown", {
                ...init,
                bubbles: true,
                cancelable: true,
              }),
            ),
          { key, ...ime },
        ),
      ).toBe(true);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("测量");
      await expect(result).toHaveText("1/2");
    }
  }
  await input.press("Enter");
  await expect(result).toHaveText("2/2");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
});
