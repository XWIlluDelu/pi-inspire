import { GlobalWorkerOptions, getDocument, TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { version } from "pdfjs-dist/package.json";

GlobalWorkerOptions.workerSrc = workerUrl;
const assets = `${import.meta.env.BASE_URL}assets/pdfjs-${version}/`;

export { TextLayer };

/** Consume only the already-authorized, bounded bytes, never a PDF-provided URL.
 * This uses the rendering API, not PDF.js's viewer/scripting/annotation layers.
 * PDF.js 6 has no eval-based font renderer. JS image decoders preserve the
 * application's strict CSP without enabling wasm-unsafe-eval.
 */
export function loadPdf(data: ArrayBuffer) {
  return getDocument({
    data,
    cMapUrl: `${assets}cmaps/`,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    useWasm: false,
    enableXfa: false,
    useSystemFonts: false,
    canvasMaxAreaInBytes: 32 * 1024 * 1024,
    stopAtErrors: true,
  });
}
