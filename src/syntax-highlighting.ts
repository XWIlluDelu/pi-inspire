import hljs from "highlight.js/lib/common";
import cmake from "highlight.js/lib/languages/cmake";
import dart from "highlight.js/lib/languages/dart";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import groovy from "highlight.js/lib/languages/groovy";
import haskell from "highlight.js/lib/languages/haskell";
import julia from "highlight.js/lib/languages/julia";
import latex from "highlight.js/lib/languages/latex";
import nginx from "highlight.js/lib/languages/nginx";
import nix from "highlight.js/lib/languages/nix";
import powershell from "highlight.js/lib/languages/powershell";
import properties from "highlight.js/lib/languages/properties";
import protobuf from "highlight.js/lib/languages/protobuf";
import scala from "highlight.js/lib/languages/scala";

hljs.registerLanguage("cmake", cmake);
hljs.registerLanguage("dart", dart);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("elixir", elixir);
hljs.registerLanguage("groovy", groovy);
hljs.registerLanguage("haskell", haskell);
hljs.registerLanguage("julia", julia);
hljs.registerLanguage("latex", latex);
hljs.registerLanguage("nginx", nginx);
hljs.registerLanguage("nix", nix);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("properties", properties);
hljs.registerLanguage("protobuf", protobuf);
hljs.registerLanguage("scala", scala);

const MAX_HIGHLIGHTED_CHARACTERS = 160 * 1024;

const FILENAME_LANGUAGES: Record<string, string> = {
  makefile: "makefile",
  gnumakefile: "makefile",
  justfile: "makefile",
  dockerfile: "dockerfile",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  vagrantfile: "ruby",
  podfile: "ruby",
  "nginx.conf": "nginx",
  "cargo.lock": "ini",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".bash_profile": "bash",
  ".zprofile": "bash",
  ".bash_logout": "bash",
  ".env": "ini",
  ".gitignore": "ini",
  ".dockerignore": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".gitconfig": "ini",
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  webmanifest: "json",
  mdx: "markdown",
  vue: "xml",
  svelte: "xml",
  astro: "xml",
  svg: "xml",
  plist: "xml",
  csproj: "xml",
  fsproj: "xml",
  xhtml: "xml",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  zsh: "bash",
  fish: "bash",
  ksh: "bash",
  sh: "bash",
  proto: "protobuf",
  tex: "latex",
  sty: "latex",
  cls: "latex",
  bib: "latex",
  toml: "ini",
  conf: "ini",
  cfg: "ini",
  env: "ini",
  tf: "ini",
  tfvars: "ini",
  hcl: "ini",
  service: "ini",
  timer: "ini",
  socket: "ini",
  properties: "properties",
  patch: "diff",
  mk: "makefile",
  dockerfile: "dockerfile",
  cmake: "cmake",
  pyi: "python",
  pyw: "python",
  kts: "kotlin",
  gradle: "groovy",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  jl: "julia",
  nix: "nix",
  dart: "dart",
  scala: "scala",
  sc: "scala",
};

/** Filename recognition complements highlight.js's language/extension aliases. */
export function languageForFile(name: string): string {
  const basename = name.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (FILENAME_LANGUAGES[basename]) return FILENAME_LANGUAGES[basename];
  if (basename.startsWith("dockerfile.")) return "dockerfile";
  if (basename.startsWith(".env.")) return "ini";
  const ext = /\.([a-z0-9]{1,12})$/.exec(basename)?.[1];
  if (!ext) return "plaintext";
  if (hljs.getLanguage(ext)) return ext;
  return EXTENSION_LANGUAGES[ext] ?? ext;
}

/** Split trusted highlighted markup into self-contained rows, preserving nested
 * multiline tokens. Highlight the source once, never each line independently. */
export function highlightSourceLines(text: string, language: string): string[] {
  const openSpans: string[] = [];
  return highlightSource(text, language)
    .split("\n")
    .map((line) => {
      const prefix = openSpans.join("");
      for (const [tag] of line.matchAll(/<span\b[^>]*>|<\/span>/g)) {
        if (tag === "</span>") openSpans.pop();
        else openSpans.push(tag);
      }
      return prefix + line + "</span>".repeat(openSpans.length);
    });
}

/** Unknown languages and large leaves stay readable, without auto-detection. */
export function highlightSource(text: string, language: string): string {
  if (text.length <= MAX_HIGHLIGHTED_CHARACTERS && hljs.getLanguage(language))
    return hljs.highlight(text, { language }).value;
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
