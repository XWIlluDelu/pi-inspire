import { describe, expect, it } from "vitest";
import {
  collectSessionResourceReferences,
  diagnosticResourceReference,
  fileResourceReference,
  isLocalResourceReference,
  isTextFileName,
  resourceReferenceLine,
  stripResourceLocation,
} from "../../shared/resource-references";
import { resourceRows } from "../../src/resources";

function textPart(text: string) {
  return { type: "text", text };
}

function message(
  role: "assistant" | "user" | "toolResult",
  ...content: unknown[]
) {
  return { role, content };
}

function readPath(path: string) {
  return { type: "toolCall", name: "read", arguments: { path } };
}

describe("Pi resource references", () => {
  it("displays native percent/hash filenames without decoding their original labels twice", () => {
    const references = collectSessionResourceReferences([
      message(
        "assistant",
        readPath("C#/report%20draft.md"),
        textPart("[Space file](C%23/report%20draft.md)"),
      ),
    ]);
    const rows = resourceRows(references);
    expect(rows.map(({ name }) => name)).toEqual([
      "report draft.md",
      "report%20draft.md",
    ]);
    expect(rows.find(({ source }) => source === "tool")!.label).toBe(
      "C#/report%20draft.md",
    );
  });

  it("does not let an incomplete Unicode path break the rest of the reference index", () => {
    expect(
      collectSessionResourceReferences([
        message(
          "assistant",
          textPart("Ignore `bad-\uD800.md` and open `healthy.md`."),
          readPath("bad-\uD800.md"),
        ),
      ]).map(({ reference }) => reference),
    ).toEqual(["healthy.md"]);
  });

  it.each([
    {
      path: "/outside/report%20draft.md",
      url: "file:///outside/report%20draft.md",
      encoded: "/outside/report%2520draft.md",
    },
    {
      path: "file:///outside/report.md",
      url: "file:///outside/report.md",
      encoded: "file%3A///outside/report.md",
    },
    {
      path: "server/share/report.md",
      url: "file://server/share/report.md",
      encoded: "server/share/report.md",
    },
  ])(
    "keeps native $path distinct from the file link $url",
    ({ path, url, encoded }) => {
      const resources = collectSessionResourceReferences([
        message("assistant", readPath(path), textPart(`[File link](${url})`)),
      ]);
      expect(resources.map(({ reference }) => reference)).toEqual([
        url,
        encoded,
      ]);
      expect(resources.find(({ source }) => source === "tool")?.label).toBe(
        path,
      );
      expect(new Set(resources.map(({ key }) => key)).size).toBe(2);
    },
  );

  it("encodes structured path metacharacters while retaining diagnostics only on text surfaces", () => {
    const resources = collectSessionResourceReferences([
      message(
        "assistant",
        readPath("C#/main.ts:12"),
        textPart(
          'See `C#/main.ts:12` and <file name="report%20draft.md"></file>.',
        ),
      ),
    ]);
    expect(resources.map(({ reference }) => reference)).toEqual([
      "report%2520draft.md",
      "C%23/main.ts:12",
      "C%23/main.ts%3A12",
    ]);
  });

  it("does not trim punctuation, whitespace or mention syntax from explicit native filenames", () => {
    const paths = [
      " file.md ",
      "@report.md",
      "<report.md>",
      "/outside/run(12)",
      "/outside/result?.md",
      "/outside/report.md!",
    ];
    const resources = collectSessionResourceReferences([
      message("assistant", {
        type: "toolCall",
        name: "read",
        arguments: { referencedImagePaths: paths },
      }),
    ]);
    expect(resources.map(({ reference }) => reference)).toEqual([
      "%20file.md%20",
      "%40report.md",
      "%3Creport.md%3E",
      "/outside/run%2812%29",
      "/outside/result%3F.md",
      "/outside/report.md%21",
    ]);
    expect(resources.map(({ label }) => label)).toEqual(paths);
  });

  it("collects structured tool paths, local Markdown targets, attachment tags, and embedded images", () => {
    const resources = collectSessionResourceReferences([
      message("user", textPart('<file name="/tmp/input one.png"></file>'), {
        type: "image",
        data: "aW1hZ2U=",
        mimeType: "image/png",
      }),
      message(
        "assistant",
        textPart(
          "Open [report](./out/report.pdf) but keep [Pi](https://pi.dev) external.",
        ),
        {
          type: "toolCall",
          name: "read",
          arguments: {
            path: "/tmp/input one.png",
            saveDir: "/tmp/generated-output",
          },
        },
      ),
    ]);

    expect(resources.map((item) => item.reference)).toEqual([
      "/tmp/input%20one.png",
      "./out/report.pdf",
      "pi-embedded://0/1",
    ]);
    expect(
      resources.some(
        (item) => item.source === "embedded" && item.mimeType === "image/png",
      ),
    ).toBe(true);
  });

  it("keeps embedded coordinates aligned with the original content array", () => {
    const resources = collectSessionResourceReferences([
      message("user", "malformed primitive", {
        type: "image",
        data: "aW1hZ2U=",
        mimeType: "image/png",
      }),
    ]);

    expect(resources.map((item) => item.reference)).toEqual([
      "pi-embedded://0/1",
    ]);
  });

  it("understands file URLs, OSC 8 targets, inline-code paths, and @ mentions", () => {
    const osc = "\u001b]8;;file:///tmp/chart.png\u0007chart\u001b]8;;\u0007";
    const resources = collectSessionResourceReferences([
      message(
        "assistant",
        textPart(`${osc}\nSee \`src/view.tsx\` and @notes/result.md.`),
      ),
    ]);
    expect(resources.map((item) => item.reference)).toEqual([
      "notes/result.md",
      "src/view.tsx",
      "file:///tmp/chart.png",
    ]);
  });

  it("recognizes bare Windows drive paths without borrowing URL or drive-relative text", () => {
    const resources = collectSessionResourceReferences([
      message(
        "assistant",
        textPart(String.raw`First C:\reports\cited.html:7:2, then (d:/reports/render.custom).
Not a file citation: C:relative.html or https://example.com/C:/report.pdf.`),
      ),
    ]);
    expect(resources.map((item) => item.reference)).toEqual([
      "d:/reports/render.custom",
      String.raw`C:\reports\cited.html:7:2`,
    ]);
  });

  it("keeps references within one text part in recent-first order", () => {
    const resources = collectSessionResourceReferences([
      message("assistant", textPart("First `old.md`, then [new](src/new.ts).")),
    ]);
    expect(resources.map((item) => item.reference)).toEqual([
      "src/new.ts",
      "old.md",
    ]);
  });

  it("deduplicates the same file and keeps the newest, strongest reference", () => {
    const resources = collectSessionResourceReferences([
      message("assistant", textPart("See `plot.png`.")),
      message("assistant", {
        type: "toolCall",
        name: "write",
        arguments: { path: "plot.png" },
      }),
    ]);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      reference: "plot.png",
      source: "tool",
      toolName: "write",
    });
  });

  it("reads inner tool calls that a code-running tool records in its details", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "toolResult",
        toolName: "codemode",
        content: [{ type: "text", text: "done" }],
        details: {
          calls: [
            { name: "read", args: '{"path":"notes/plan.md"}', status: "ok" },
            { name: "edit", args: '{"path":"runExperiment.m"}', status: "ok" },
            { name: "write", args: { path: "out/summary.md" }, status: "ok" },
            { name: "edit", args: '{"path":"broken.m"}', status: "error" },
            { name: "bash", args: "not json", status: "ok" },
          ],
        },
      },
    ]);
    expect(
      resources.map(({ reference, toolName, writes }) => ({
        reference,
        toolName,
        writes,
      })),
    ).toEqual([
      { reference: "broken.m", toolName: undefined, writes: undefined },
      { reference: "out/summary.md", toolName: "write", writes: true },
      { reference: "runExperiment.m", toolName: "edit", writes: true },
      { reference: "notes/plan.md", toolName: "read", writes: undefined },
    ]);
  });

  it("does not surface hidden custom content or independently hidden thinking", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "secret/path.pdf" }],
      },
      {
        role: "custom",
        display: false,
        content: [{ type: "text", text: "[hidden](hidden.png)" }],
      },
    ]);
    expect(resources).toEqual([]);
  });

  it("rejects remote and executable URL schemes without rejecting ordinary local files", () => {
    expect(isLocalResourceReference("https://example.com/a.pdf")).toBe(false);
    expect(isLocalResourceReference("javascript:alert(1)")).toBe(false);
    expect(isLocalResourceReference("example.com/report.pdf")).toBe(false);
    expect(isLocalResourceReference("report.pdf#L2")).toBe(true);
    expect(isLocalResourceReference("report.pdf#page=2")).toBe(true);
    expect(isLocalResourceReference("../figures/chart.svg")).toBe(true);
    expect(isLocalResourceReference("/repo/LICENSE")).toBe(true);
    expect(isLocalResourceReference("/unstaged/")).toBe(false);
    expect(isLocalResourceReference("/**")).toBe(false);
  });

  it("does not mine remote URL paths or query parameters for local citations", () => {
    for (const text of [
      "https://example.test/redirect?path=(/tmp/private.md)",
      "[remote](https://example.test/redirect?path=(/tmp/private.md))",
      "ftp://example.test/report.ps1",
      "ssh://example.test/report.ps1",
    ]) {
      expect(
        collectSessionResourceReferences([
          message("assistant", textPart(text)),
        ]),
      ).toEqual([]);
    }
  });

  it.each([
    ["src/view.tsx:123:7", "src/view.tsx", 123],
    ["src/view.tsx#L9-L12", "src/view.tsx", 9],
    ["src/view.tsx:4?raw=1", "src/view.tsx", 4],
    ["src/view.tsx#L0", "src/view.tsx", null],
    ["src/view.tsx", "src/view.tsx", null],
    [
      String.raw`C:\My Project\file.cpp(12,3)`,
      String.raw`C:\My Project\file.cpp`,
      12,
    ],
  ])("uses the same location grammar for %s", (input, path, line) => {
    expect(stripResourceLocation(input)).toBe(path);
    expect(resourceReferenceLine(input)).toBe(line);
  });

  it.each([
    "setup.ps1",
    "build.cmd",
    ".bashrc",
    ".gitconfig",
    "main.m",
    "App.csproj",
    "Directory.Build.targets",
    "App.slnx",
    "Info.plist",
  ])("recognizes native text source/configuration: %s", (name) => {
    expect(isTextFileName(name)).toBe(true);
    expect(isLocalResourceReference(name)).toBe(true);
  });

  it.each([
    "\\\\nas\\results\\ARTIFACT",
    "~\\ARTIFACT",
    ".\\ARTIFACT",
    "..\\ARTIFACT",
  ])(
    "collects native structured file paths without an extension: %s",
    (path) => {
      const resources = collectSessionResourceReferences([
        message("assistant", readPath(path)),
      ]);
      expect(resources.map((item) => item.reference)).toEqual([
        fileResourceReference(path),
      ]);
      expect(resources[0]!.label).toBe(path);
    },
  );

  it.each([
    [
      "C:\\Users\\Jane Doe\\repo\\main.ts:12:3: error TS1000: missing symbol",
      "C:\\Users\\Jane Doe\\repo\\main.ts:12:3",
    ],
    [
      "/Users/Jane Doe/Project (copy)/main.m:7:2: warning: missing semicolon",
      "/Users/Jane Doe/Project (copy)/main.m:7:2",
    ],
    [
      "\\\\nas\\Results Share\\ARTIFACT:12: failed",
      "\\\\nas\\Results Share\\ARTIFACT:12",
    ],
    ["~\\My Project\\file.ps1:24:2: error", "~\\My Project\\file.ps1:24:2"],
    [".\\My Project\\file.ps1:24", ".\\My Project\\file.ps1:24"],
    [
      "/Users/Jane Doe/repo/report.custom:9",
      "/Users/Jane Doe/repo/report.custom:9",
    ],
    [
      "C:\\Projects\\My App\\main.cpp(12,3): error C1000: syntax",
      "C:\\Projects\\My App\\main.cpp(12,3)",
    ],
    [
      "C:\\Projects\\My App\\main.cpp(12): warning C1000: syntax",
      "C:\\Projects\\My App\\main.cpp(12)",
    ],
  ])("preserves the entire diagnostic path: %s", (text, reference) => {
    const resources = collectSessionResourceReferences([
      message("toolResult", textPart(text)),
    ]);
    expect(resources.map((item) => item.reference)).toEqual([
      diagnosticResourceReference(reference),
    ]);
    expect(resources[0]!.label).toBe(reference);
  });

  it.each([
    [
      'Open "C:\\Users\\Jane Doe\\repo\\ARTIFACT" now.',
      "C:\\Users\\Jane Doe\\repo\\ARTIFACT",
    ],
    [
      'Open "/Users/Jane O\'Neil/Project Files/report.custom" now.',
      "/Users/Jane O'Neil/Project Files/report.custom",
    ],
    [
      "'/Users/Jane Doe/Project Files/report.custom'",
      "/Users/Jane Doe/Project Files/report.custom",
    ],
    ["/Users/Jane Doe/repo/notes.txt", "/Users/Jane Doe/repo/notes.txt"],
    [
      "C:\\Users\\Jane Doe\\repo\\ARTIFACT",
      "C:\\Users\\Jane Doe\\repo\\ARTIFACT",
    ],
    [
      "\\\\nas\\Results Share\\output\\ARTIFACT",
      "\\\\nas\\Results Share\\output\\ARTIFACT",
    ],
    ["`/Users/Jane Doe/repo/notes.txt`", "/Users/Jane Doe/repo/notes.txt"],
    [
      "[notes](</Users/Jane Doe/repo/notes.txt>)",
      "/Users/Jane Doe/repo/notes.txt",
      true,
    ],
  ])(
    "preserves a delimited or whole-line path: %s",
    (text, reference, authoredLink = false) => {
      const resources = collectSessionResourceReferences([
        message("assistant", textPart(text)),
      ]);
      expect(resources).toHaveLength(1);
      expect(resources[0]!.label).toBe(reference);
      expect(resources[0]!.reference).toBe(
        authoredLink ? reference : diagnosticResourceReference(reference),
      );
    },
  );

  it("does not grant a shortened prefix of an ambiguous space-containing path", () => {
    const resources = collectSessionResourceReferences([
      message(
        "assistant",
        textPart("Please inspect /Users/Jane Doe/the results when convenient."),
      ),
    ]);
    expect(resources).toEqual([]);
  });

  it("keeps separate native paths in recent-first order without joining prose into a filename", () => {
    const text =
      "First /tmp/one.log, then /Users/Jane Doe/repo/two.m:12:3: error";
    const resources = collectSessionResourceReferences([
      message("toolResult", textPart(text)),
    ]);
    expect(resources.map((item) => item.reference)).toEqual([
      "/Users/Jane%20Doe/repo/two.m:12:3",
      "/tmp/one.log",
    ]);
  });

  it("stops the recent-first walk at the presented bound, leaving authority callers complete", () => {
    const messages = Array.from({ length: 20 }, (_, index) =>
      message("assistant", textPart(`wrote \`file-${index}.md\``)),
    );

    const bounded = collectSessionResourceReferences(messages, 8);
    expect(bounded).toHaveLength(8);
    // Newest first: the bound keeps the most recent references, not the first.
    expect(bounded[0]?.reference).toBe("file-19.md");
    expect(bounded.at(-1)?.reference).toBe("file-12.md");
    // No limit means no truncation — the authorization path sees everything.
    expect(collectSessionResourceReferences(messages)).toHaveLength(20);
  });
});
