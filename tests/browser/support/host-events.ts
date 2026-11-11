import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import type {
  ActiveSnapshot,
  BootstrapResponse,
  SessionRuntimeStatus,
} from "../../../shared/contracts";
import type { ToolPresentationConfiguration } from "../../../shared/tool-presentation-config";
import { browserWorkspace } from "../fixtures/workspace.mjs";
import { hostRequest } from "./host-request";
import { pairedPage, reloadSession } from "./navigation";

type SnapshotEvent = {
  type: string;
  data?: ActiveSnapshot;
  detailSessionId?: string;
  sessionId?: string;
  sessionStatus?: SessionRuntimeStatus;
};

// Keep HTTP bootstrap/open/recovery and live snapshots consistent. Fixtures own
// their domain state; this helper only owns the Host's transport envelopes.
export async function routeSnapshots(
  page: Page,
  options: {
    snapshot?: (snapshot: ActiveSnapshot) => void;
    bootstrap?: (bootstrap: BootstrapResponse) => void;
    event?: (event: SnapshotEvent) => false | void;
  },
) {
  let socket: WebSocketRoute | undefined;
  let detailSessionId: string | undefined;
  let authority = "";
  await page.routeWebSocket(/\/events(?:\?|$)/, (client) => {
    socket = client;
    detailSessionId = undefined;
    const upstream = client.connectToServer();
    upstream.onMessage((message) => {
      if (socket !== client) return;
      const event = JSON.parse(String(message)) as SnapshotEvent;
      if (event.type === "snapshot") {
        detailSessionId = event.detailSessionId;
        if (event.data) options.snapshot?.(event.data);
      }
      if (options.event?.(event) === false) return;
      client.send(JSON.stringify(event));
    });
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
    ready: (sessionId: string) => detailSessionId === sessionId,
    async reload(
      sessionId: string,
      load: () => Promise<unknown> = () => page.reload(),
    ) {
      const previous = socket;
      await load();
      await expect
        .poll(() => socket !== previous && detailSessionId === sessionId)
        .toBe(true);
    },
    send(event: Record<string, unknown>) {
      if (!socket) throw new Error("No Host event connection");
      socket.send(JSON.stringify(event));
    },
  };
}

// Tool/custom-message presentations both need an empty owned session and a
// synchronized live event stream, not the Host selection left by another test.
export async function openEventSession(
  page: Page,
  name: string,
  toolPresentations: ToolPresentationConfiguration,
  preferences: Record<string, unknown>,
) {
  const transport = await routeSnapshots(page, {
    bootstrap: (body) => {
      Object.assign(body.preferences, preferences);
      body.toolPresentations = toolPresentations;
    },
  });
  await pairedPage(page);
  const created = await hostRequest(page).post("/api/sessions/new", {
    data: { cwd: browserWorkspace, name },
  });
  expect(created.ok()).toBe(true);
  const createdSnapshot: ActiveSnapshot = await created.json();
  const createdSessionId = createdSnapshot.active!.sessionId;
  await transport.reload(createdSessionId, () =>
    reloadSession(page, createdSessionId),
  );
  await expect(
    page.getByRole("button", { name: /^Session actions:/ }),
  ).toHaveText(name);
  return (...events: Record<string, unknown>[]) => {
    for (const event of events)
      transport.send({ ...event, sessionId: createdSessionId });
  };
}
