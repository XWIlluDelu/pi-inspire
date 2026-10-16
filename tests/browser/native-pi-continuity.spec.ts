import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createInspireServer } from "../../server/app.js";
import { GitInspectionService } from "../../server/git-inspection.js";
import { piInstallation } from "../../server/pi-runtime.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";
import {
  nativeHerdrAvailable,
  nativeHerdrFixture,
} from "../server/fixtures/native-herdr.js";
import { browserTestToken, openMockSession } from "./support/navigation.js";

test("continue the same native Pi in the browser without closing its terminal", async ({
  page,
}) => {
  test.skip(
    !nativeHerdrAvailable,
    "Requires Herdr and its native Pi integration",
  );
  test.setTimeout(60_000);
  const f = await nativeHerdrFixture({ streamDelayMs: 3000 });
  const application = createInspireServer({
    token: browserTestToken,
    runtime: f.makeRuntime(),
    catalog: f.catalog,
    attachments: f.store,
    preferences: new PreferencesStore(join(f.root, "preferences.json")),
    resources: new ResourceStore(),
    git: new GitInspectionService(),
    mock: false,
    version: "0.0.0-native-test",
    piVersion: piInstallation.version,
  });
  try {
    await new Promise<void>((resolve) =>
      application.server.listen(0, "127.0.0.1", resolve),
    );
    const port = (application.server.address() as AddressInfo).port;
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByLabel("Access token").fill(browserTestToken);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(page.getByRole("main")).toBeVisible();
    await openMockSession(page, /Native Pi continuity/);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("Continue the existing Pi from this browser");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Abort running task", exact: true }),
    ).toBeVisible();
    await input.fill("Follow up after the original task");
    await page.getByRole("button", { name: "Queue", exact: true }).click();
    await page
      .getByRole("button", { name: "Queue after current task", exact: true })
      .click();
    await expect(
      page.getByText("global physical a reply", { exact: true }),
    ).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByRole("log")).toContainText(
      "Follow up after the original task",
    );
    await expect(input).toHaveValue("");
    await expect(
      page.getByText(/already running elsewhere|Pi runtime stopped/),
    ).toHaveCount(0);
    expect(
      (await f.observer.findNativeWriter(f.sessionId, f.sessionFile))?.pid,
    ).toBe(f.originalPid);
    await page.reload();
    await expect(
      page.getByText("global physical a reply", { exact: true }),
    ).toHaveCount(2);
    await input.fill("Continue after reconnecting the browser");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      page.getByText("global physical a reply", { exact: true }),
    ).toHaveCount(3, { timeout: 15_000 });
    expect(
      (await f.observer.findNativeWriter(f.sessionId, f.sessionFile))?.pid,
    ).toBe(f.originalPid);
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeVisible();
    await input.fill("Interrupt this response without closing Pi");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await f.client.nativeAgentRequest(
              f.pane.serverId,
              f.pane.paneId,
              "agent.get",
            )
          ).agent,
      )
      .toMatchObject({ agent_status: "working" });
    await page
      .getByRole("button", { name: "Abort running task", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeVisible({ timeout: 5000 });
    await expect
      .poll(() => f.readHistory())
      .toContain('"stopReason":"aborted"');
    expect(
      (await f.observer.findNativeWriter(f.sessionId, f.sessionFile))?.pid,
    ).toBe(f.originalPid);
  } finally {
    await application.close();
    await f.close();
  }
});
