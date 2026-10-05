import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  modelOption,
  modelSwitchThinkingLevel,
} from "../../server/model-catalog.js";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from "../../server/pi-runtime.js";
import type { ModelOption, ThinkingLevel } from "../../shared/contracts.js";

afterEach(() => vi.unstubAllEnvs());
it("matches native setModel configured precedence and capability clamping without writing settings or sessions", async () => {
  // Execute the actual browser policy without expanding the server composite
  // project's source list to include browser modules.
  const browserPolicyPath = resolve("src/model-options.ts");
  const { clampThinkingLevel } = (await import(browserPolicyPath)) as {
    clampThinkingLevel(
      model: ModelOption | null,
      level: ThinkingLevel,
    ): ThinkingLevel;
  };
  const root = await mkdtemp(join(tmpdir(), "inspire-thinking-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.stubEnv("PI_OFFLINE", "1");
  const cwd = join(root, "workspace");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  new ProjectTrustStore(root).set(cwd, true);
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
  await writeFile(join(root, "auth.json"), "{}");
  await writeFile(
    join(root, "models.json"),
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
    ] as Array<
      [
        ThinkingLevel,
        string,
        ThinkingLevel | undefined,
        ThinkingLevel | undefined,
        ThinkingLevel | undefined,
        ThinkingLevel,
      ]
    >) {
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
      await writeFile(join(root, "settings.json"), settingsText);
      await writeFile(join(cwd, ".pi/settings.json"), projectText);
      const settings = SettingsManager.create(cwd, root);
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: root,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd,
        agentDir: root,
        settingsManager: settings,
        modelRuntime: runtime,
        model: runtime.getModel("fixture", "extended")!,
        thinkingLevel: current,
        sessionManager: SessionManager.inMemory(cwd),
        resourceLoader: loader,
        noTools: "all",
      });
      try {
        const targetModel = runtime.getModel("fixture", target)!;
        const requested = modelSwitchThinkingLevel(
          cwd,
          "fixture",
          target,
          current,
        );
        const predicted = clampThinkingLevel(
          modelOption(targetModel),
          requested,
        );
        await session.setModel(targetModel);
        expect(predicted).toBe(expected);
        expect(session.thinkingLevel).toBe(predicted);
        expect(await readFile(join(root, "settings.json"), "utf8")).toBe(
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
