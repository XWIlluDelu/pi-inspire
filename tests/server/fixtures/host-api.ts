import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { type ClientOptions, WebSocket } from "ws";
import { createInspireServer } from "../../../server/app.js";
import { GitInspectionService } from "../../../server/git-inspection.js";
import {
  type HostRestartBackend,
  HostRestartController,
} from "../../../server/host-restart.js";
import { PreferencesStore } from "../../../server/preferences.js";
import { ResourceStore } from "../../../server/resources.js";
import { ToolPresentationConfigStore } from "../../../server/tool-presentation-config.js";
import { UpdateCoordinator } from "../../../server/update-coordinator.js";
import { SessionManager } from "../../../server/pi-runtime.js";
import type {
  ActiveSnapshot,
  SessionRuntimeStatus,
} from "../../../shared/contracts.js";
import type { ActivityTool } from "../../../shared/tool-activity.js";
import { hostServices } from "../../fixtures/host-services.js";
import { workbenchFixture } from "../../fixtures/workbench.js";
import { listenOnLoopback } from "./offline-model.js";

type DetailFrame = Record<string, unknown> & {
  type: string;
  data?: ActiveSnapshot;
  sessionStatus?: SessionRuntimeStatus;
  toolActivity?: Record<string, ActivityTool>;
};

export function observeEventSocket(url: string, options: ClientOptions = {}) {
  const frames: DetailFrame[] = [];
  const socket = new WebSocket(url, {
    ...options,
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
  return { bearer: exchanged.body.bearer as string };
}

export async function socketAdmission(
  server: import("node:http").Server,
  origin: string,
  bearer: string,
  audience = "events",
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await request(server)
    .post("/api/auth/socket-ticket")
    .set("Origin", origin)
    .set("Authorization", `Bearer ${bearer}`)
    .set(headers)
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

type HostDependencies = Parameters<typeof createInspireServer>[0];
type HostFixtureServices = Pick<
  HostDependencies,
  "runtime" | "catalog" | "attachments"
> & { cwd: string };
type HostFixtureOptions = Partial<
  Pick<
    HostDependencies,
    | "modelSettings"
    | "mcpConfig"
    | "modelMetadata"
    | "providerAuth"
    | "invalidateModels"
    | "token"
    | "activeHerdrMode"
    | "maintenanceRestart"
    | "instanceState"
    | "getHerdrStatus"
    | "websocketHeartbeatIntervalMs"
    | "promptObservationWindowMs"
    | "distDir"
    | "terminal"
    | "piVersion"
  >
> & { services?: HostFixtureServices; restartBackend?: HostRestartBackend };

export async function hostApiFixture({
  services,
  restartBackend,
  piVersion = "0.80.10",
  ...options
}: HostFixtureOptions = {}) {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-test-")),
  );
  const previousEnvironment = {
    agent: process.env.PI_CODING_AGENT_DIR,
    sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
  };
  const resources = new ResourceStore();
  if (!services) {
    const workbench = await workbenchFixture(join(temporary, ".host"), {
      rich: false,
    });
    process.env.PI_CODING_AGENT_DIR = workbench.agent;
    process.env.PI_CODING_AGENT_SESSION_DIR = workbench.sessions;
    services = workbench;
  }
  const { cwd, runtime, catalog, attachments } = services;
  const application = createInspireServer({
    token,
    runtime,
    catalog,
    attachments,
    hostRestart: restartBackend
      ? new HostRestartController(runtime, restartBackend)
      : undefined,
    preferences: new PreferencesStore(join(temporary, "preferences.json")),
    toolPresentations: new ToolPresentationConfigStore(
      join(temporary, "tool-presentations.json"),
    ),
    resources,
    git: new GitInspectionService(),
    version: "0.1.0-test",
    piVersion,
    updateCoordinator: new UpdateCoordinator({
      currentPiVersion: piVersion,
      probeInspire: async () => ({
        kind: "available",
        update: {
          currentVersion: "0.1.0-test",
          latestVersion: "0.2.0",
          releaseUrl: "https://github.com/example/inspire/releases/tag/v0.2.0",
        },
      }),
      probePi: async () => ({
        currentVersion: piVersion,
        installedVersion: piVersion,
        pi: {
          kind: "available",
          latestVersion: "0.84.3",
          releaseUrl: "https://pi.dev/changelog",
        },
        extensions: {
          kind: "available",
          updates: [{ displayName: "pi-web-access", type: "npm" }],
        },
      }),
    }),
    bootstrapModels: () => [fixtureModel],
    modelMetadata: async (cwd) => ({
      models: [fixtureModel],
      virtualModels: [],
      defaults: { cwd, model: fixtureModel, thinkingLevel: "high" },
    }),
    distDir: join(temporary, "missing-dist"),
    ...options,
  });
  const baseUrl = await listenOnLoopback(application.server);
  const authorization = `Bearer ${options.token ?? token}`;
  const localRequest = request
    .agent(application.server)
    .set("Authorization", authorization);
  const nativeFetch = globalThis.fetch;
  const fetchHost: typeof fetch = (input, init) => {
    const url = new URL(String(input), baseUrl);
    if (url.origin !== baseUrl)
      throw new Error("Request left the fixture Host");
    const headers = new Headers(init?.headers);
    headers.set("Authorization", authorization);
    return nativeFetch(url, { ...init, headers });
  };
  const api = () => localRequest.get("/api/bootstrap");
  function promptDelivery<T extends Record<string, unknown>>(body: T) {
    return {
      ...body,
      operationId: randomUUID(),
      authorityId: application.authorityId,
    };
  }
  return {
    temporary,
    previousEnvironment,
    cwd,
    catalog,
    resources,
    attachments,
    runtime,
    application,
    baseUrl,
    fetchHost,
    localRequest,
    api,
    promptDelivery,
  };
}

export async function closeHostApiFixture(
  fixture: Awaited<ReturnType<typeof hostApiFixture>>,
) {
  await fixture.application.close();
  for (const [key, value] of Object.entries({
    PI_CODING_AGENT_DIR: fixture.previousEnvironment.agent,
    PI_CODING_AGENT_SESSION_DIR: fixture.previousEnvironment.sessions,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fixture.temporary, { recursive: true, force: true, maxRetries: 3 });
}

export async function configurationHost(
  workspace: { root: string; cwd: string; sessions: string },
  options: HostFixtureOptions,
) {
  const { root, cwd, sessions } = workspace;
  const saved = SessionManager.create(cwd, sessions);
  saved.appendMessage({ role: "user", content: "Saved fixture", timestamp: 1 });
  saved.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Offline answer" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: 2,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const host = await hostApiFixture({
    ...options,
    services: { cwd, ...hostServices(root, { cwd }) },
  });
  try {
    const sessionId = saved.getSessionId();
    await host.runtime.openSession(sessionId);
    return { ...host, sessionId };
  } catch (error) {
    await closeHostApiFixture(host);
    throw error;
  }
}
