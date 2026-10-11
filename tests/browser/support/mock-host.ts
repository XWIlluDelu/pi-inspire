import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import type {
  ActiveSnapshot,
  BootstrapResponse,
} from "../../../shared/contracts";
import type { ToolPresentationConfiguration } from "../../../shared/tool-presentation-config";
import { browserWorkspace } from "../fixtures/workspace.mjs";
import { pairedPage } from "./navigation";

type SnapshotEvent = {
  type: string;
  data?: ActiveSnapshot;
  detailSessionId?: string;
};

// Keep HTTP bootstrap/open/recovery and live snapshots consistent. Fixtures own
// their domain state; this helper only owns the mock Host's transport envelopes.
export async function routeMockSnapshots(
  page: Page,
  options: {
    snapshot?: (snapshot: ActiveSnapshot) => void;
    bootstrap?: (bootstrap: BootstrapResponse) => void;
    event?: (event: SnapshotEvent) => void;
  },
) {
  let socket: WebSocketRoute;
  let authority = "";
  await page.routeWebSocket(/\/events(?:\?|$)/, (client) => {
    socket = client;
    const upstream = client.connectToServer();
    upstream.onMessage((message) => {
      if (socket !== client) return;
      const event = JSON.parse(String(message));
      if (event.type === "snapshot" && event.data)
        options.snapshot?.(event.data);
      options.event?.(event);
      client.send(JSON.stringify(event));
    });
    client.onMessage((message) => upstream.send(message));
  });
  for (const pattern of [
    "**/api/bootstrap**",
    "**/api/snapshot**",
    "**/api/sessions/open",
  ]) {
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      authority = response.headers()["x-inspire-authority"] ?? authority;
      if (!response.ok()) return route.fulfill({ response });
      const body = await response.json();
      if (body.snapshot) {
        options.snapshot?.(body.snapshot);
        options.bootstrap?.(body);
      } else if ("active" in body) options.snapshot?.(body);
      await route.fulfill({ response, json: body });
    });
  }
  return {
    authority: () => authority,
    send: (event: Record<string, unknown>) =>
      socket.send(JSON.stringify(event)),
  };
}

// Tool/custom-message presentations both need an empty owned session and a
// synchronized live event stream, not the Host selection left by another test.
export async function openMockEventSession(
  page: Page,
  name: string,
  toolPresentations: ToolPresentationConfiguration,
  preferences: Record<string, unknown>,
) {
  let sessionId: string | null = null;
  const transport = await routeMockSnapshots(page, {
    bootstrap: (body) => {
      Object.assign(body.preferences, preferences);
      body.toolPresentations = toolPresentations;
    },
    event: (event) => {
      if (event.type === "snapshot")
        sessionId =
          event.detailSessionId ?? event.data?.active?.sessionId ?? null;
    },
  });
  await pairedPage(page);
  const created = await page.request.post("/api/sessions/new", {
    data: { cwd: browserWorkspace, name },
  });
  expect(created.ok()).toBe(true);
  const createdSnapshot: ActiveSnapshot = await created.json();
  const createdSessionId = createdSnapshot.active!.sessionId;
  sessionId = null;
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^Session actions:/ }),
  ).toHaveText(name);
  // Reload can race a final snapshot from the old socket. Titles are not
  // identities, and any non-null session could belong to that retiring page.
  // Wait for this admission's handshake before injecting its live events.
  await expect.poll(() => sessionId).toBe(createdSessionId);
  return (...events: Record<string, unknown>[]) => {
    for (const event of events)
      transport.send({ ...event, sessionId: createdSessionId });
  };
}
