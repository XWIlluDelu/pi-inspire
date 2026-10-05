import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { SessionProjection } from "../../server/session-projection.js";
import { codemodeCalls } from "../../shared/tool-activity.js";

const script = `const results = await Promise.allSettled([
  tools.fixture_leaf({path: "ok.txt"}),
  tools.fixture_leaf({path: "failed.txt", fail: true})
]);
const model = await models.getModelOfType("classifier", "child-model-fixture", "classifier");
const classified = await models.classify(model, { state: { message: "fixture" }, questions: { useful: { type: "bool", instructions: "Is it useful?", criteria: { true: "useful", false: "not useful" } } } });
text({ succeeded: results.filter(result => result.status === "fulfilled").length, probability: classified.answers.useful.probability });`;

it("projects native raw-JS Codemode and generic descendants live and after reopening", async () => {
  await mkdir(resolve("output/native"), { recursive: true });
  const root = await mkdtemp(resolve("output/native/child-calls-"));
  const agent = join(root, "agent");
  const sessions = join(root, "sessions");
  await mkdir(agent);
  await mkdir(sessions);
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const first = ++requestCount === 1;
    if (first)
      expect(body.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "custom", name: "codemode" }),
        ]),
      );
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (event: unknown) =>
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    const output = first
      ? [
          {
            type: "custom_tool_call",
            id: "ctc_script",
            call_id: "script",
            name: "codemode",
            input: script,
            status: "completed",
          },
          {
            type: "function_call",
            id: "fc_parent",
            call_id: "parent",
            name: "fixture_parent",
            arguments: "{}",
            status: "completed",
          },
        ]
      : [
          {
            type: "message",
            id: "msg_done",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done", annotations: [] }],
          },
        ];
    if (first) {
      emit({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...output[0], input: "" },
      });
      emit({
        type: "response.custom_tool_call_input.delta",
        output_index: 0,
        delta: script,
      });
    }
    output.forEach((item, output_index) =>
      emit({ type: "response.output_item.done", output_index, item }),
    );
    emit({
      type: "response.completed",
      response: {
        id: `resp_${requestCount}`,
        status: "completed",
        output,
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    });
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  await writeFile(join(agent, "auth.json"), "{}");
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      defaultProjectTrust: "never",
      enableInstallTelemetry: false,
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
      packages: [],
      skills: [],
      prompts: [],
      themes: [],
    }),
  );
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "child-chat-fixture": {
          api: "openai-responses",
          apiKey: "synthetic",
          baseUrl,
          models: [
            {
              id: "chat",
              name: "Offline fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 64000,
              maxTokens: 2048,
              compat: { supportsOpenAIGrammarTools: true },
            },
          ],
        },
      },
    }),
  );
  const rpc = new PiRpcProcess({
    cwd: root,
    args: [
      "--session-dir",
      sessions,
      "--extension",
      resolve("tests/fixtures/pi-child-calls-extension.ts"),
      "--tools",
      "codemode,fixture_parent,fixture_branch,fixture_leaf",
      "--provider",
      "child-chat-fixture",
      "--model",
      "chat",
      "--thinking",
      "off",
    ],
    env: {
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      PI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      TMPDIR: root,
    },
  });
  const events: Array<Record<string, unknown>> = [];
  let codemodeRunning = false;
  let genericRunning = false;
  rpc.on("event", (event: Record<string, unknown>) => {
    events.push(event);
    const partial = event.partialResult as { details?: unknown } | undefined;
    codemodeRunning ||=
      event.toolName === "codemode" &&
      Boolean(
        codemodeCalls(partial?.details)?.calls.some(
          (call) => call.status === "running",
        ),
      );
    genericRunning ||=
      event.type === "tool_execution_start" &&
      typeof event.parentToolCallId === "string";
  });
  let projection: SessionProjection | undefined;
  try {
    await rpc.start();
    await rpc.request({ type: "prompt", message: "Run the fixture" });
    await vi.waitFor(
      () =>
        expect(events.some((event) => event.type === "agent_settled")).toBe(
          true,
        ),
      { timeout: 15_000 },
    );
    expect(codemodeRunning).toBe(true);
    expect(genericRunning).toBe(true);
    const state = await rpc.request<{ sessionId: string; sessionFile: string }>(
      { type: "get_state" },
    );
    await rpc.stop();
    const entries = (await readFile(state.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const rawResults = entries
      .filter((entry) => entry.message?.role === "toolResult")
      .map((entry) => entry.message);
    expect(rawResults).toHaveLength(2);
    const rawScript = entries
      .flatMap((entry) => entry.message?.content ?? [])
      .find((part) => part.type === "toolCall" && part.name === "codemode");
    expect(rawScript.arguments).toEqual({ code: script });
    expect(
      rawResults.find((result) => result.toolName === "codemode").details.calls,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "models.classify",
          args: "child-model-fixture/classifier",
          status: "ok",
        }),
      ]),
    );
    expect(
      rawResults.find((result) => result.toolName === "fixture_parent"),
    ).toMatchObject({
      isError: false,
      nestedCalls: {
        complete: true,
        calls: expect.arrayContaining([
          expect.objectContaining({ name: "fixture_leaf", status: "error" }),
        ]),
      },
    });
    projection = await SessionProjection.open({
      id: state.sessionId,
      path: state.sessionFile,
      cwd: root,
      source: null,
      created: new Date(),
      modified: new Date(),
      messageCount: 4,
      firstMessage: "Run the fixture",
      searchText: "fixture",
    });
    const messages = projection.latestPage().messages as Array<
      Record<string, unknown>
    >;
    const results = messages.filter((message) => message.role === "toolResult");
    expect(
      results.find((result) => result.toolName === "codemode")?.__inspireCalls,
    ).toMatchObject({
      source: "codemode",
      calls: [
        { key: "codemode:0", status: "ok" },
        { key: "codemode:1", status: "error" },
        { key: "codemode:2", name: "models.classify" },
      ],
    });
    expect(
      results.find((result) => result.toolName === "fixture_parent")
        ?.__inspireCalls,
    ).toMatchObject({
      source: "nested",
      calls: expect.arrayContaining([
        expect.objectContaining({
          name: "fixture_leaf",
          arguments: { path: "deep.txt" },
        }),
      ]),
    });
    expect(JSON.stringify(results)).not.toContain("PRIVATE_CHILD_RESULT");
    expect(JSON.stringify(results)).not.toContain("PRIVATE_CHILD_UPDATE");
    expect(requestCount).toBe(2);
  } finally {
    await rpc.stop();
    await projection?.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
