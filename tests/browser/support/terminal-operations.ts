import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

export async function terminalMutationHeaders(page: Page) {
  const response = await page.request.get("/api/terminal-operations");
  expect(response.ok()).toBe(true);
  const { epoch } = await response.json();
  return {
    "X-Terminal-Operation": JSON.stringify({ id: randomUUID(), epoch }),
  };
}
