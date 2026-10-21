import { describe, expect, it } from "vitest";
import {
  collectSessionResourceReferences,
  diagnosticResourceReference,
  fileResourceReference,
  isLocalResourceReference,
  isTextFileName,
  RESOURCE_LIST_INITIAL_SIZE,
  resourceReferenceLine,
  stripResourceLocation,
} from "../../shared/resource-references";
import { resourceRows } from "../../src/resources";

describe("Pi resource references", () => {
  it("displays native percent/hash filenames without decoding their original labels twice", () => {
    const references = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { path: "C#/report%20draft.md" },
          },
          { type: "text", text: "[Space file](C%23/report%20draft.md)" },
        ],
      },
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
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Ignore \`bad-\uD800.md\` and open \`healthy.md\`.`,
            },
            {
              type: "toolCall",
              name: "read",
              arguments: { path: "bad-\uD800.md" },
            },
          ],
        },
      ]).map(({ reference }) => reference),
    ).toEqual(["healthy.md"]);
  });

  it("keeps literal file paths distinct from URL targets without guessing which file exists", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { path: "/outside/report%20draft.md" },
          },
          {
            type: "text",
            text: "[Space file](file:///outside/report%20draft.md)",
          },
        ],
      },
    ]);
    expect(resources).toHaveLength(2);
    expect(resources.map(({ reference }) => reference)).toEqual([
      "file:///outside/report%20draft.md",
      "/outside/report%2520draft.md",
    ]);
    expect(new Set(resources.map(({ key }) => key)).size).toBe(2);
    expect(resources.find(({ source }) => source === "tool")?.label).toBe(
      "/outside/report%20draft.md",
    );
  });

  it("keeps a URL-looking structured field literal while text URLs remain links", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { path: "file:///outside/report.md" },
          },
          { type: "text", text: "[URL](file:///outside/report.md)" },
        ],
      },
    ]);
    expect(resources.map(({ reference }) => reference)).toEqual([
      "file:///outside/report.md",
      "file%3A///outside/report.md",
    ]);
    expect(new Set(resources.map(({ key }) => key)).size).toBe(2);
  });

  it("keeps a file URL authority separate from a conversation-relative native path", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { path: "server/share/report.md" },
          },
          { type: "text", text: "[UNC file](file://server/share/report.md)" },
        ],
      },
    ]);
    expect(resources).toHaveLength(2);
    expect(new Set(resources.map(({ key }) => key)).size).toBe(2);
  });

  it("encodes structured path metacharacters while retaining diagnostics only on text surfaces", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { path: "C#/main.ts:12" },
          },
          {
            type: "text",
            text: 'See `C#/main.ts:12` and <file name="report%20draft.md"></file>.',
          },
        ],
      },
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
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { referencedImagePaths: paths },
          },
        ],
      },
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
      {
        role: "user",
        content: [
          { type: "text", text: '<file name="/tmp/input one.png"></file>' },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Open [report](./out/report.pdf) but keep [Pi](https://pi.dev) external.",
          },
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: {
              path: "/tmp/input one.png",
              saveDir: "/tmp/generated-output",
            },
          },
        ],
      },
    ]);

    expect(resources.map((item) => item.reference).filter(Boolean)).toEqual([
      "/tmp/input%20one.png",
      "./out/report.pdf",
      "pi-embedded://0/1",
    ]);
    expect(
      resources.some(
        (item) => item.source === "embedded" && item.mimeType === "image/png",
      ),
    ).toBe(true);
    expect(resources.some((item) => item.reference === "https://pi.dev")).toBe(
      false,
    );
    expect(
      resources.some((item) => item.reference === "/tmp/generated-output"),
    ).toBe(false);
  });

  it("keeps embedded coordinates aligned with the original content array", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "user",
        content: [
          "malformed primitive",
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      },
    ]);

    expect(resources.map((item) => item.reference)).toEqual([
      "pi-embedded://0/1",
    ]);
  });

  it("understands file URLs, OSC 8 targets, inline-code paths, and @ mentions", () => {
    const osc = "\u001b]8;;file:///tmp/chart.png\u0007chart\u001b]8;;\u0007";
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `${osc}\nSee \`src/view.tsx\` and @notes/result.md.`,
          },
        ],
      },
    ]);
    expect(resources.map((item) => item.reference)).toEqual([
      "notes/result.md",
      "src/view.tsx",
      "file:///tmp/chart.png",
    ]);
  });

  it("recognizes bare Windows drive paths without borrowing URL or drive-relative text", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: String.raw`First C:\reports\cited.html:7:2, then (d:/reports/render.custom).
Not a file citation: C:relative.html or https://example.com/C:/report.pdf.`,
          },
        ],
      },
    ]);
    expect(resources.map((item) => item.reference)).toEqual([
      "d:/reports/render.custom",
      String.raw`C:\reports\cited.html:7:2`,
    ]);
  });

  it("keeps references within one text part in recent-first order", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "First `old.md`, then [new](src/new.ts).",
          },
        ],
      },
    ]);
    expect(resources.map((item) => item.reference)).toEqual([
      "src/new.ts",
      "old.md",
    ]);
  });

  it("deduplicates the same file and keeps the newest, strongest reference", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [{ type: "text", text: "See `plot.png`." }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "write-1",
            name: "write",
            arguments: { path: "plot.png" },
          },
        ],
      },
    ]);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      reference: "plot.png",
      source: "tool",
      toolName: "write",
    });
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
          { role: "assistant", content: [{ type: "text", text }] },
        ]),
      ).toEqual([]);
    }
  });

  it("uses one location grammar for resolution and source-line navigation", () => {
    expect(stripResourceLocation("src/view.tsx:123:7")).toBe("src/view.tsx");
    expect(stripResourceLocation("src/view.tsx#L9-L12")).toBe("src/view.tsx");
    expect(resourceReferenceLine("@src/view.tsx:123:7")).toBe(123);
    expect(resourceReferenceLine("<src/view.tsx#L9-L12>")).toBe(9);
    expect(resourceReferenceLine("src/view.tsx:4?raw=1")).toBe(4);
    expect(resourceReferenceLine("src/view.tsx#L0")).toBeNull();
    expect(resourceReferenceLine("src/view.tsx")).toBeNull();
    expect(
      stripResourceLocation(String.raw`C:\My Project\file.cpp(12,3)`),
    ).toBe(String.raw`C:\My Project\file.cpp`);
    expect(
      resourceReferenceLine(String.raw`C:\My Project\file.cpp(12,3)`),
    ).toBe(12);
    expect(
      resourceReferenceLine(String.raw`C:\My Project\file.cpp(0)`),
    ).toBeNull();
  });

  it.each([
    "setup.ps1",
    "module.psm1",
    "module.psd1",
    "build.cmd",
    "build.bat",
    "profile.bash",
    ".bashrc",
    ".bash_profile",
    "profile.zsh",
    ".zshrc",
    ".zprofile",
    ".gitconfig",
    ".gitattributes",
    "config.fish",
    "main.m",
    "main.mm",
    "App.csproj",
    "App.fsproj",
    "App.vbproj",
    "Directory.Build.props",
    "Directory.Build.targets",
    "App.sln",
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
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "read", arguments: { path } }],
        },
      ]);
      expect(resources.map((item) => item.reference)).toEqual([
        fileResourceReference(path),
      ]);
      expect(resources[0]!.label).toBe(path);
    },
  );

  it.each([
    {
      text: "C:\\Users\\Jane Doe\\repo\\main.ts:12:3: error TS1000: missing symbol",
      reference: "C:\\Users\\Jane Doe\\repo\\main.ts:12:3",
    },
    {
      text: "/Users/Jane Doe/Project (copy)/main.m:7:2: warning: missing semicolon",
      reference: "/Users/Jane Doe/Project (copy)/main.m:7:2",
    },
    {
      text: "\\\\nas\\Results Share\\ARTIFACT:12: failed",
      reference: "\\\\nas\\Results Share\\ARTIFACT:12",
    },
    {
      text: "~\\My Project\\file.ps1:24:2: error",
      reference: "~\\My Project\\file.ps1:24:2",
    },
    {
      text: ".\\My Project\\file.ps1:24",
      reference: ".\\My Project\\file.ps1:24",
    },
    {
      text: "/Users/Jane Doe/repo/report.custom:9",
      reference: "/Users/Jane Doe/repo/report.custom:9",
    },
    {
      text: "C:\\Projects\\My App\\main.cpp(12,3): error C1000: syntax",
      reference: "C:\\Projects\\My App\\main.cpp(12,3)",
    },
    {
      text: "C:\\Projects\\My App\\main.cpp(12): warning C1000: syntax",
      reference: "C:\\Projects\\My App\\main.cpp(12)",
    },
  ])("preserves the entire diagnostic path: $text", ({ text, reference }) => {
    const resources = collectSessionResourceReferences([
      { role: "toolResult", content: [{ type: "text", text }] },
    ]);
    expect(resources.map((item) => item.reference)).toEqual([
      diagnosticResourceReference(reference),
    ]);
    expect(resources[0]!.label).toBe(reference);
  });

  it.each([
    {
      text: 'Open "C:\\Users\\Jane Doe\\repo\\ARTIFACT" now.',
      reference: "C:\\Users\\Jane Doe\\repo\\ARTIFACT",
    },
    {
      text: 'Open "/Users/Jane O\'Neil/Project Files/report.custom" now.',
      reference: "/Users/Jane O'Neil/Project Files/report.custom",
    },
    {
      text: "'/Users/Jane Doe/Project Files/report.custom'",
      reference: "/Users/Jane Doe/Project Files/report.custom",
    },
    {
      text: "/Users/Jane Doe/repo/notes.txt",
      reference: "/Users/Jane Doe/repo/notes.txt",
    },
    {
      text: "C:\\Users\\Jane Doe\\repo\\ARTIFACT",
      reference: "C:\\Users\\Jane Doe\\repo\\ARTIFACT",
    },
    {
      text: "\\\\nas\\Results Share\\output\\ARTIFACT",
      reference: "\\\\nas\\Results Share\\output\\ARTIFACT",
    },
    {
      text: "`/Users/Jane Doe/repo/notes.txt`",
      reference: "/Users/Jane Doe/repo/notes.txt",
    },
    {
      text: "[notes](</Users/Jane Doe/repo/notes.txt>)",
      reference: "/Users/Jane Doe/repo/notes.txt",
    },
  ])(
    "preserves a delimited or whole-line path: $text",
    ({ text, reference }) => {
      const resources = collectSessionResourceReferences([
        { role: "assistant", content: [{ type: "text", text }] },
      ]);
      expect(resources).toHaveLength(1);
      expect(resources[0]!.label).toBe(reference);
      expect(resources[0]!.reference).toBe(
        resources[0]!.source === "link"
          ? reference
          : diagnosticResourceReference(reference),
      );
    },
  );

  it("does not grant a shortened prefix of an ambiguous space-containing path", () => {
    const resources = collectSessionResourceReferences([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Please inspect /Users/Jane Doe/the results when convenient.",
          },
        ],
      },
    ]);
    expect(resources).toEqual([]);
  });

  it("keeps separate native paths in recent-first order without joining prose into a filename", () => {
    const text =
      "First /tmp/one.log, then /Users/Jane Doe/repo/two.m:12:3: error";
    const resources = collectSessionResourceReferences([
      { role: "toolResult", content: [{ type: "text", text }] },
    ]);
    expect(resources.map((item) => item.reference)).toEqual([
      "/Users/Jane%20Doe/repo/two.m:12:3",
      "/tmp/one.log",
    ]);
  });

  it("stops the recent-first walk at the presented bound, leaving authority callers complete", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: "assistant",
      content: [{ type: "text", text: `wrote \`file-${index}.md\`` }],
    }));

    const bounded = collectSessionResourceReferences(
      messages,
      RESOURCE_LIST_INITIAL_SIZE,
    );
    expect(bounded).toHaveLength(RESOURCE_LIST_INITIAL_SIZE);
    // Newest first: the bound keeps the most recent references, not the first.
    expect(bounded[0]?.reference).toBe("file-19.md");
    expect(bounded.at(-1)?.reference).toBe(
      `file-${20 - RESOURCE_LIST_INITIAL_SIZE}.md`,
    );
    // No limit means no truncation — the authorization path sees everything.
    expect(collectSessionResourceReferences(messages)).toHaveLength(20);
  });
});
