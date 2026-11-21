import { Code2, Workflow } from "lucide-react";
import { memo, useEffect, useId, useState } from "react";
import { CodeView } from "./CodeView";
import { ActivityHeader } from "./transcript-activity-visibility";

type MermaidApi = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<MermaidApi> | null = null;
let initializedTheme: "dark" | "default" | null = null;

function documentTheme(): "dark" | "default" {
  return typeof document !== "undefined" &&
    document.documentElement.dataset.theme === "dark"
    ? "dark"
    : "default";
}

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid").then((mod) => mod.default);
  return mermaidPromise;
}

async function renderDiagram(
  id: string,
  source: string,
  theme: "dark" | "default",
): Promise<string> {
  const mermaid = await loadMermaid();
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      fontFamily: "var(--font-sans)",
    });
    initializedTheme = theme;
  }
  const { svg } = await mermaid.render(id, source);
  return svg;
}

export const RichTextMermaid = memo(function RichTextMermaid({
  code,
}: {
  code: string;
}) {
  const renderId = `inspire-mermaid-${useId().replace(/[^A-Za-z0-9_-]/gu, "")}`;
  const [showSource, setShowSource] = useState(false);
  const [theme, setTheme] = useState<"dark" | "default">(documentTheme);
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const update = () => setTheme(documentTheme());
    const observer = new MutationObserver(update);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (showSource) return;
    const trimmed = code.trim();
    if (!trimmed) {
      setSvg(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void renderDiagram(renderId, trimmed, theme)
        .then((rendered) => {
          if (!cancelled) setSvg(rendered);
        })
        .catch(() => {
          if (!cancelled) setSvg(null);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, renderId, showSource, theme]);

  return (
    <div className="code-block mermaid-block">
      <ActivityHeader
        className="code-block__bar"
        copy={{ text: code, label: "Mermaid source", copiedLabel: "Copied" }}
      >
        <span className="code-block__lang">mermaid</span>
        <button
          type="button"
          className="icon-button activity-copy"
          onClick={() => setShowSource((current) => !current)}
          aria-label={showSource ? "Show diagram" : "Show source"}
          title={showSource ? "Show diagram" : "Show source"}
        >
          {showSource ? (
            <Workflow size={13} aria-hidden />
          ) : (
            <Code2 size={13} aria-hidden />
          )}
        </button>
      </ActivityHeader>
      {!showSource && svg ? (
        <div
          className="mermaid-block__diagram"
          // Mermaid runs with securityLevel: "strict" (DOMPurify-sanitized SVG).
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <CodeView
          className="code-block__pre"
          tabIndex={0}
          text={code}
          language="mermaid"
        />
      )}
    </div>
  );
});
