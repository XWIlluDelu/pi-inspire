import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { vi } from "vitest";
import { WebSocket } from "ws";
import { createInspireServer } from "../../../server/app.js";
import { AttachmentStore } from "../../../server/attachments.js";
import type { GitInspectionLike } from "../../../server/git-inspection.js";
import { MockCatalog, MockRuntime } from "../../../server/mock.js";
import { PreferencesStore } from "../../../server/preferences.js";
import { ResourceStore } from "../../../server/resources.js";
import { ToolPresentationConfigStore } from "../../../server/tool-presentation-config.js";
import type {
  ActiveSnapshot,
  SessionRuntimeStatus,
} from "../../../shared/contracts.js";

export type DetailFrame = Record<string, unknown> & {
  data?: ActiveSnapshot;
  snapshotDigest?: string;
  sessionStatus?: SessionRuntimeStatus;
};

export function observeEventSocket(url: string) {
  const frames: DetailFrame[] = [];
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  return { socket, frames };
}

export const token = "test-local-token";

export async function pairedBrowser(
  server: import("node:http").Server,
  origin: string,
  master = token,
) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const paired = await request(server)
    .post("/api/auth/pair")
    .set("Origin", origin)
    .send({
      token: master,
      publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    })
    .expect(200);
  const certificate = paired.body.certificate as string;
  const challengeResponse = await request(server)
    .post("/api/auth/challenge")
    .set("Origin", origin)
    .send({ certificate })
    .expect(200);
  const challenge = challengeResponse.body.challenge as string;
  const signature = sign("sha256", Buffer.from(challenge), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  const exchanged = await request(server)
    .post("/api/auth/exchange")
    .set("Origin", origin)
    .send({ challenge, signature })
    .expect(200);
  return {
    bearer: exchanged.body.bearer as string,
    certificate,
    privateKey,
    publicKey: jwk,
  };
}

export async function socketAdmission(
  server: import("node:http").Server,
  origin: string,
  bearer: string,
  audience = "events",
): Promise<string> {
  const response = await request(server)
    .post("/api/auth/socket-ticket")
    .set("Origin", origin)
    .set("Authorization", `Bearer ${bearer}`)
    .send({ audience })
    .expect(200);
  return response.body.ticket as string;
}
const fixtureModel = {
  provider: "anthropic",
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  reasoning: true,
};

export async function hostApiFixture(
  options: {
    token?: string;
    maintenanceRestart?: Parameters<
      typeof createInspireServer
    >[0]["maintenanceRestart"];
    instanceState?: () =>
      | import("../../../server/instance-state.mjs").InstanceState
      | null;
    websocketHeartbeatIntervalMs?: number;
    promptObservationWindowMs?: number;
    runtime?: Parameters<typeof createInspireServer>[0]["runtime"] &
      Pick<MockRuntime, "emit">;
    distDir?: string;
    staticAssetCacheDirs?: string[];
  } = {},
) {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-test-")),
  );
  const resources = new ResourceStore();
  const attachments = new AttachmentStore(join(temporary, "uploads"));
  const runtime = options.runtime ?? new MockRuntime({ attachments });
  const git: GitInspectionLike = {
    status: vi.fn(async () => ({ kind: "not-repository" as const })),
    diff: vi.fn(async (_cwd, pathId, side) => ({
      kind: "empty" as const,
      path: {
        id: pathId,
        display: "file.txt",
        utf8Path: "file.txt",
        workspacePath: "file.txt",
      },
      side,
      reason: "no-changes" as const,
    })),
  };
  const shutdown = vi.fn<() => void>();
  const application = createInspireServer({
    token,
    runtime,
    catalog: new MockCatalog(),
    attachments,
    preferences: new PreferencesStore(join(temporary, "preferences.json")),
    toolPresentations: new ToolPresentationConfigStore(
      join(temporary, "tool-presentations.json"),
    ),
    resources,
    git,
    mock: true,
    version: "0.1.0-test",
    piVersion: "0.80.10",
    updateChecker: {
      check: async () => ({
        kind: "available",
        update: {
          currentVersion: "0.1.0-test",
          latestVersion: "0.2.0",
          releaseUrl: "https://github.com/example/inspire/releases/tag/v0.2.0",
        },
      }),
    },
    piUpdateChecker: {
      check: async () => ({
        currentVersion: "0.80.10",
        pi: {
          kind: "available",
          latestVersion: "0.84.3",
          releaseUrl: "https://pi.dev/changelog",
        },
        extensions: {
          kind: "available",
          updates: [
            {
              displayName: "pi-web-access",
              type: "npm",
            },
          ],
        },
      }),
    },
    bootstrapModels: () => [fixtureModel],
    availableModels: async () => [fixtureModel],
    modelMetadata: async (cwd) => ({
      models: [fixtureModel],
      virtualModels: [],
      defaults: { cwd, model: fixtureModel, thinkingLevel: "high" },
    }),
    distDir: join(temporary, "missing-dist"),
    shutdown,
    ...options,
  });
  await new Promise<void>((resolve) =>
    application.server.listen(0, "127.0.0.1", resolve),
  );
  const address = application.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const api = () =>
    request(application.server)
      .get("/api/bootstrap")
      .set("Authorization", `Bearer ${options.token ?? token}`);
  function promptDelivery<T extends Record<string, unknown>>(body: T) {
    return {
      ...body,
      operationId: randomUUID(),
      authorityId: application.authorityId,
    };
  }
  return {
    temporary,
    resources,
    attachments,
    runtime,
    git,
    shutdown,
    application,
    baseUrl,
    api,
    promptDelivery,
  };
}

export async function closeHostApiFixture(
  fixture: Awaited<ReturnType<typeof hostApiFixture>>,
) {
  await fixture.application.close();
  await rm(fixture.temporary, { recursive: true, force: true });
}
