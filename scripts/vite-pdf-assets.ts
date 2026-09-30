import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);

/** PDF.js resolves built-in fonts/CMaps/decoders by filename. Keep that small
 * asset tree versioned, locally served and available in both dev and releases.
 * Do not ship the optional scripting engine or WebAssembly decoders.
 */
export function pdfAssets(): Plugin {
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const { version } = require("pdfjs-dist/package.json") as { version: string };
  const prefix = `assets/pdfjs-${version}/`;
  const files = new Map<string, string>();
  return {
    name: "inspire-pdf-assets",
    async buildStart() {
      for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
        for (const name of await readdir(join(root, directory))) {
          if (
            directory === "wasm" &&
            !/^(?:jbig2_nowasm_fallback\.js|openjpeg_nowasm_fallback\.js|LICENSE_(?:JBIG2|OPENJPEG|PDFJS_JBIG2|PDFJS_OPENJPEG))$/.test(
              name,
            )
          )
            continue;
          files.set(
            `${prefix}${directory}/${name}`,
            join(root, directory, name),
          );
        }
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = files.get((request.url ?? "").split("?")[0]!.slice(1));
        if (!path) return next();
        response.setHeader(
          "Content-Type",
          path.endsWith(".js") ? "text/javascript" : "application/octet-stream",
        );
        createReadStream(path).on("error", next).pipe(response);
      });
    },
    async generateBundle() {
      for (const [fileName, path] of files)
        this.emitFile({
          type: "asset",
          fileName,
          source: await readFile(path),
        });
    },
  };
}
