import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { userMessageEvidence } from "../../server/pending-image-evidence.js";
import { PiRpcProcess, MAX_RPC_LINE_BYTES } from "../../server/pi-rpc.js";
import { newBridgeIdentity } from "../../server/runtime-branch-bridge.js";
import { readPendingImageEvidence } from "../../server/runtime-pending-image-evidence.js";
import { PENDING_IMAGE_SUFFIX } from "../../shared/branch-bridge-protocol.js";

it("reads an append cursor and image identities without transporting a large native history", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspire-image-evidence-"));
  const config = join(root, "config");
  await mkdir(config);
  await writeFile(join(config, "auth.json"), "{}");
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({
      defaultProjectTrust: "never",
      enableInstallTelemetry: false,
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    }),
  );
  const sessionId = "99999999-9999-4999-8999-999999999999";
  const session = join(root, "images.jsonl");
  const image = {
    type: "image",
    data: Buffer.alloc(14 * 1024 * 1024, 7).toString("base64"),
    mimeType: "image/png",
  };
  const messages = [1, 1].map((timestamp) => ({
    role: "user",
    content: [{ type: "text", text: "same caption" }, image],
    timestamp,
  }));
  expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(
    MAX_RPC_LINE_BYTES,
  );
  await writeFile(
    session,
    [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: root,
      },
      ...messages.map((message, index) => ({
        type: "message",
        id: `m${index}`,
        parentId: index ? `m${index - 1}` : null,
        timestamp: new Date(index + 1).toISOString(),
        message,
      })),
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  const bridge = newBridgeIdentity();
  const rpc = new PiRpcProcess({
    cwd: root,
    args: [
      "--session",
      session,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--extension",
      resolve("server/extensions/inspire-branch-bridge.ts"),
    ],
    env: {
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      APPDATA: join(root, "appdata"),
      LOCALAPPDATA: join(root, "localappdata"),
      PI_CODING_AGENT_DIR: config,
      PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      INSPIRE_BRANCH_COMMAND: bridge.command,
      INSPIRE_BRANCH_STATUS_KEY: bridge.statusKey,
      INSPIRE_BRANCH_WORKER_ID: bridge.workerId,
    },
  });
  const evidenceEvents: unknown[] = [];
  rpc.on("event", (event) => {
    if (event.statusKey === `${bridge.statusKey}${PENDING_IMAGE_SUFFIX}`)
      evidenceEvents.push(event);
  });
  try {
    await rpc.start();
    const baseline = await readPendingImageEvidence(rpc, bridge, sessionId);
    // Pi can append prompt/tool state during startup after the seeded messages.
    expect(baseline).toEqual({ cursor: expect.any(String), messages: [] });
    expect(Buffer.byteLength(JSON.stringify(evidenceEvents))).toBeLessThan(
      1024,
    );
    evidenceEvents.length = 0;
    // Corroboration preserves multiplicity even for identical native identities.
    const observed = await readPendingImageEvidence(
      rpc,
      bridge,
      sessionId,
      null,
    );
    expect(observed).toEqual({
      cursor: baseline.cursor,
      messages: messages.map(userMessageEvidence),
    });
    expect(observed.messages[0]!.fingerprint).toBe(
      observed.messages[1]!.fingerprint,
    );
    expect(observed.messages[0]!.identity).toBe(observed.messages[1]!.identity);
    expect(Buffer.byteLength(JSON.stringify(evidenceEvents))).toBeLessThan(
      4096,
    );
    expect(
      await readPendingImageEvidence(rpc, bridge, sessionId, baseline.cursor),
    ).toEqual({ cursor: baseline.cursor, messages: [] });
    await expect(
      readPendingImageEvidence(rpc, bridge, sessionId, "missing"),
    ).rejects.toThrow("Pi did not confirm pending image evidence");
    expect(
      (await rpc.request<{ sessionId: string }>({ type: "get_state" }))
        .sessionId,
    ).toBe(sessionId);
    expect(rpc.available).toBe(true);
  } finally {
    await rpc.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
