import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  modelOption,
  modelSettings,
  modelThinkingPreferences,
} from "../../server/model-catalog.js";
import {
  createAgentSession,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
} from "../../server/pi-runtime.js";
import { modelSwitchThinkingLevel } from "../../shared/model-settings.js";

import {
  clampThinkingLevel,
  supportedThinkingLevels,
} from "../../src/model-options";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "../server/fixtures/native-pi";

afterEach(() => vi.unstubAllEnvs());
it("matches native setModel preferences, supported levels and capability clamping", async () => {
  const { root, agent, cwd, env } = await nativePiWorkspace(
    "inspire-thinking-",
    {},
  );
  stubNativePiEnvironment(env);
  await mkdir(join(cwd, ".pi"));
  new ProjectTrustStore(agent).set(cwd, true);
  const models = [
    {
      id: "extended",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    },
    { id: "ordinary", reasoning: true },
    {
      id: "holes",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        max: null,
      },
    },
    { id: "plain", reasoning: false },
  ];
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          apiKey: "synthetic",
          baseUrl: "http://127.0.0.1:1",
          models,
        },
      },
    }),
  );
  try {
    const runtime = await ModelRuntime.create();
    for (const [current, target, global, perModel, project, expected] of [
      ["xhigh", "ordinary", undefined, undefined, undefined, "high"],
      ["max", "ordinary", undefined, undefined, undefined, "high"],
      ["low", "ordinary", "high", undefined, undefined, "high"],
      ["max", "ordinary", "high", "low", undefined, "low"],
      ["max", "holes", undefined, "minimal", undefined, "high"],
      ["high", "plain", "max", undefined, undefined, "off"],
      ["low", "ordinary", "low", "high", "medium", "medium"],
    ] as const) {
      const settingsText = JSON.stringify({
        defaultThinkingLevel: global,
        modelThinkingLevels: perModel
          ? { [`fixture/${target}`]: perModel }
          : undefined,
      });
      const projectText = JSON.stringify({
        modelThinkingLevels: project
          ? { [`fixture/${target}`]: project }
          : undefined,
      });
      await writeFile(join(agent, "settings.json"), settingsText);
      await writeFile(join(cwd, ".pi/settings.json"), projectText);
      const settings = modelSettings(cwd, agent);
      const { session } = await createAgentSession({
        cwd,
        agentDir: agent,
        settingsManager: settings,
        modelRuntime: runtime,
        model: runtime.getModel("fixture", "extended")!,
        thinkingLevel: current,
        sessionManager: SessionManager.inMemory(cwd),
        noTools: "all",
      });
      try {
        expect(supportedThinkingLevels(modelOption(session.model!))).toEqual(
          session.getAvailableThinkingLevels(),
        );
        const targetModel = runtime.getModel("fixture", target)!;
        const choice = modelOption(targetModel);
        const predicted = clampThinkingLevel(
          choice,
          modelSwitchThinkingLevel(
            choice,
            modelThinkingPreferences(settings),
            current,
          ),
        );
        await session.setModel(targetModel);
        expect(supportedThinkingLevels(choice)).toEqual(
          session.getAvailableThinkingLevels(),
        );
        expect(predicted).toBe(expected);
        expect(session.thinkingLevel).toBe(predicted);
        expect(await readFile(join(agent, "settings.json"), "utf8")).toBe(
          settingsText,
        );
        expect(await readFile(join(cwd, ".pi/settings.json"), "utf8")).toBe(
          projectText,
        );
      } finally {
        session.dispose();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
