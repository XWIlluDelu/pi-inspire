import { describe, expect, it } from "vitest";
import { PI_NATIVE_COMMANDS } from "../../shared/commands";
import {
  commandArgumentCandidates,
  commandUsageHint,
  parseCaretCompletion,
  rankCommands,
  rankProjectFiles,
  replaceCompletionToken,
  replaceFileCompletion,
  resolveCommandInventory,
} from "../../src/composer-completion";

describe("composer caret completion", () => {
  it("keeps session-bound built-ins off the new-session command surface", () => {
    const runtime = [
      { name: "compact", source: "extension", description: "collision" },
      { name: "skill:docs", source: "skill", description: "Docs" },
    ];
    expect(resolveCommandInventory(runtime, false)).toEqual([
      expect.objectContaining({ name: "compact", source: "builtin" }),
      runtime[1],
    ]);
    expect(resolveCommandInventory(runtime, false)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "settings" })]),
    );
    expect(resolveCommandInventory(runtime)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "compact",
          source: "builtin",
        }),
        runtime[1],
      ]),
    );
  });

  it("recognizes only the active boundary-prefixed @ token and permits spaces", () => {
    const draft = "keep @notes/field report final";
    expect(parseCaretCompletion(draft, draft.length)).toEqual({
      kind: "file",
      start: 5,
      end: draft.length,
      query: "notes/field report final",
    });
    expect(parseCaretCompletion("mail@example.com", 16)).toBeNull();
    expect(parseCaretCompletion("prefix@src/main.ts", 18)).toBeNull();
  });

  it("uses the caret token rather than reinterpreting earlier @ text", () => {
    const draft = "@first remains\nthen @second";
    expect(parseCaretCompletion(draft, draft.length)).toMatchObject({
      kind: "file",
      start: draft.lastIndexOf("@"),
      query: "second",
    });
    expect(
      parseCaretCompletion("use @src/ma|in.ts later".replace("|", ""), 11),
    ).toMatchObject({
      query: "src/ma",
      end: 16,
    });
  });

  it("offers slash completion only while the caret is in Pi's leading command token", () => {
    expect(parseCaretCompletion("/comp instructions", 5)).toEqual({
      kind: "command",
      start: 0,
      end: 5,
      query: "comp",
    });
    expect(parseCaretCompletion("/compact instructions", 12)).toBeNull();
    expect(parseCaretCompletion("please /compact", 15)).toBeNull();
  });

  it("replaces exactly the parsed range and reports the restored caret", () => {
    const value = "before @src/main after";
    const token = parseCaretCompletion(value, 16)!;
    expect(
      replaceFileCompletion(value, token, {
        path: "src/main.ts",
        name: "main.ts",
      }),
    ).toEqual({
      value: 'before @"src/main.ts" after',
      caret: 22,
    });

    const command = parseCaretCompletion("/com existing args", 3)!;
    expect(
      replaceCompletionToken("/com existing args", command, "/compact "),
    ).toEqual({
      value: "/compact  existing args",
      caret: 9,
    });
  });

  it("preserves multiple and repeated inline references and quotes paths with spaces", () => {
    const file = { path: "docs/field report.md", name: "field report.md" };
    const draft = "Compare @src/main.ts with @field then @src/main.ts.";
    const caret = draft.indexOf(" then");
    const inserted = replaceFileCompletion(
      draft,
      parseCaretCompletion(draft, caret)!,
      file,
    );
    expect(inserted.value).toBe(
      'Compare @src/main.ts with @"docs/field report.md" then @src/main.ts.',
    );
    expect(inserted.value.slice(inserted.caret)).toBe("then @src/main.ts.");
    expect(parseCaretCompletion(inserted.value, inserted.caret)).toBeNull();
    const quoted = 'Read @"docs/field report.md" carefully';
    const token = parseCaretCompletion(quoted, quoted.indexOf("report"))!;
    expect(token.query).toBe("docs/field ");
    expect(replaceFileCompletion(quoted, token, file).value).toBe(quoted);
    expect(
      replaceFileCompletion(
        "@field",
        { start: 0, end: 6 },
        { ...file, workspaceCwd: "/project" },
      ).value,
    ).toBe('@"/project/docs/field report.md" ');
  });

  it("reconstructs selected reference boundaries and reopens editing inside the path", () => {
    const inserted = replaceFileCompletion(
      "Read @src",
      { start: 5, end: 9 },
      { path: "src/main.ts", name: "main.ts" },
    );
    const reloaded = `${inserted.value}and explain more`;
    expect(inserted.value).toBe('Read @"src/main.ts" ');
    expect(parseCaretCompletion(reloaded, reloaded.length)).toBeNull();
    expect(
      parseCaretCompletion(reloaded, reloaded.indexOf("main")),
    ).toMatchObject({ kind: "file", query: "src/", end: 19 });
    const pair = 'Compare @"src/main.ts" with @other';
    expect(parseCaretCompletion(pair, pair.length)).toMatchObject({
      query: "other",
    });
    const unusual = replaceFileCompletion(
      "@file",
      { start: 0, end: 5 },
      { path: 'docs/a "quoted" @note.md', name: "file" },
    );
    expect(
      parseCaretCompletion(`${unusual.value}more`, unusual.value.length + 4),
    ).toBeNull();
  });

  it("respects native argument scope and supported levels without extension guesses", () => {
    expect(parseCaretCompletion("/thinking high trailing", 12)).toMatchObject({
      kind: "argument",
      name: "thinking",
      start: 10,
      end: 14,
      query: "hi",
    });
    expect(parseCaretCompletion("/thinking high trailing", 19)).toBeNull();
    const token = {
      kind: "argument" as const,
      name: "thinking" as const,
      start: 10,
      end: 10,
      query: "",
    };
    const model = {
      provider: "test",
      id: "reasoning",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: null },
    };
    const values = commandArgumentCandidates(token, [model], model).map(
      (candidate) => candidate.value,
    );
    expect(values).toContain("xhigh");
    expect(values).not.toContain("max");
    expect(
      commandArgumentCandidates(token, [], {
        provider: "test",
        id: "plain",
        reasoning: false,
      }),
    ).toEqual([]);
    expect(commandUsageHint("/model foo", false)).toBeNull();
    expect(commandUsageHint("/review foo")).toBeNull();
  });

  it("ranks basename and directory matches locally", () => {
    const files = rankProjectFiles(
      [
        { path: "docs/field report.md", name: "field report.md" },
        { path: "src/report-field.ts", name: "report-field.ts" },
        { path: "other.txt", name: "other.txt" },
      ],
      "field report",
    );
    expect(files.map((file) => file.path)).toEqual([
      "docs/field report.md",
      "src/report-field.ts",
    ]);
  });

  it("uses Pi's command-name matcher rather than unrelated description text", () => {
    const commands = rankCommands(
      [
        { name: "loop", description: "Run repeatedly", source: "prompt" },
        {
          name: "review-loop",
          description: "Review repeatedly",
          source: "extension",
        },
        {
          name: "goal",
          description: "Run a loop to completion",
          source: "extension",
        },
      ],
      "loop",
    );
    expect(commands.map((command) => command.name)).toEqual([
      "loop",
      "review-loop",
    ]);
  });
});

describe("Pi interactive command ownership", () => {
  it.each(PI_NATIVE_COMMANDS)(
    "reserves /$name ahead of every runtime source",
    (builtin) => {
      for (const source of ["extension", "prompt", "skill"]) {
        const resolved = resolveCommandInventory([
          { name: builtin.name, source },
        ]);
        expect(
          resolved.filter((command) => command.name === builtin.name),
        ).toEqual([
          expect.objectContaining({
            source: "builtin",
            execution: builtin.execution,
          }),
        ]);
      }
    },
  );
  it("does not offer unavailable built-in collisions in a first-message composer", () => {
    const commands = [
      { name: "model", source: "extension" },
      { name: "export", source: "prompt" },
      { name: "plugin:model", source: "extension" },
    ];
    expect(
      resolveCommandInventory(commands, false).map((command) => command.name),
    ).toEqual(["plugin:model", "compact"]);
  });
});
