import type { Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { memo } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import rehypeKatex from "rehype-katex";
import { unified } from "unified";

const mathProcessor = unified().use(rehypeKatex, {
  trust: false,
  strict: false,
  throwOnError: false,
});

/** Called only for math markers from RichText's sanitized Markdown tree.
 * Keep the established rehype-katex rendering/error behavior, but materialize
 * its large HAST/React subtree only when this expression changes. React owns
 * the cache lifetime: one result per mounted expression, not a source-history
 * map. No Markdown is parsed here and no untrusted HTML is introduced. */
export const RichTextMath = memo(function RichTextMath({
  value,
  display,
}: {
  value: string;
  display: boolean;
}) {
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "code",
        properties: { className: [display ? "math-display" : "math-inline"] },
        children: [{ type: "text", value }],
      },
    ],
  };
  // KaTeX's trust:false output is generated markup, not model HTML. This is
  // the same HAST-to-React converter used by react-markdown, without another
  // Markdown parse or an unnecessary HTML string/DOM boundary.
  return toJsxRuntime(mathProcessor.runSync(tree) as Root, {
    Fragment,
    jsx,
    jsxs,
    ignoreInvalidStyle: true,
  });
});
