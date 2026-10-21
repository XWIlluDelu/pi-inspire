import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findImportBoundaryViolations } from "../../scripts/check-import-boundaries.mjs";

const directories = [];

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "inspire-import-boundaries-"));
  directories.push(root);
  await Promise.all([
    writeFile(join(root, "package.json"), '{"type":"module"}\n'),
    writeFile(
      join(root, "tsconfig.server.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
        },
      }),
    ),
    writeFile(
      join(root, "tsconfig.web.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          noEmit: true,
        },
      }),
    ),
  ]);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const output = join(root, path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, content);
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("import-boundary checker", () => {
  it("resolves NodeNext .js specifiers to TypeScript source before applying boundaries", async () => {
    const root = await fixture({
      "server/illegal.ts": 'import "../src/store.js";\n',
      "server/runtime.ts": "export {};\n",
      "shared/illegal.ts": 'import "../server/runtime.js";\n',
      "src/store.ts": "export {};\n",
      "src/controllers/illegal.ts": 'import "../components/Foo";\n',
      "src/controllers/okay.ts": "export {};\n",
      "src/components/Foo.tsx": "export {};\n",
      "src/components/valid.ts": 'import "../controllers/okay";\n',
    });

    await expect(findImportBoundaryViolations(root)).resolves.toEqual(
      expect.arrayContaining([
        "server/illegal.ts must not import src/store.ts",
        "shared/illegal.ts must not import server/runtime.ts",
        "src/controllers/illegal.ts must not import src/components/Foo.tsx",
      ]),
    );
  });

  it("allows valid directional imports", async () => {
    const root = await fixture({
      "src/controllers/selection.ts": "export {};\n",
      "src/components/Navigation.tsx": 'import "../controllers/selection";\n',
    });

    await expect(findImportBoundaryViolations(root)).resolves.toEqual([]);
  });
});
