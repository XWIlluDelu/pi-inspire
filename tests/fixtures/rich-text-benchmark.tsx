import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { RichText } from "../../src/components/RichText";
import "../../src/styles.css";

const mixed = String.raw`## Streaming technical answer

A paragraph with **emphasis**, a [reference](https://example.com), and inline $E=mc^2$.

| Quantity | Value |
| --- | --- |
| Energy | $\\alpha + \\beta$ |
| Status | complete |

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

\`\`\`typescript
function square(value: number): number {
  return value * value;
}
\`\`\`

- First result
- Second result with enough ordinary prose to resemble a technical answer.

`
  .replaceAll("\\`", "`")
  .replaceAll("\\\\", "\\");
const plain =
  "Ordinary streaming prose with no expensive embedded rendering. ".repeat(8) +
  "\n\n";

async function frame(): Promise<number> {
  return new Promise<number>((resolve) =>
    requestAnimationFrame(() => resolve(performance.now())),
  );
}

async function rendered(
  host: HTMLElement,
  start = performance.now(),
): Promise<number> {
  let previous = start;
  let largestGap = 0;
  do {
    const now = await frame();
    largestGap = Math.max(largestGap, now - previous);
    previous = now;
  } while (host.querySelector('[aria-busy="true"]'));
  if (!host.querySelector(".rich-text"))
    throw new Error("RichText did not render");
  return largestGap;
}

// Measure immediate source commit, full rich-render latency, and the largest
// animation-frame gap during each update. The latter includes deferred React
// work as well as the initial commit. No Host or transport is involved.
Object.assign(window, {
  async benchmarkRichTextSemantics() {
    const padding = "A complete ordinary paragraph.\n\n".repeat(1_100);
    const cases = [
      {
        name: "forward definitions",
        prefix: "[Forward][later] and a footnote[^value].\n\n" + padding,
        tail: "[later]: /docs/reference.md\n\n[^value]: Footnote value\n",
        check: (host: HTMLElement) =>
          Boolean(
            host.querySelector('[data-file-path="/docs/reference.md"]') &&
              host.querySelector("sup a"),
          ),
      },
      {
        name: "quote/list continuation",
        prefix: "> - First item\n>\n>   " + padding.replaceAll("\n", "\n>   "),
        tail: "continued **emphasis**\n> - Second item\n\nOutside quote.",
        check: (host: HTMLElement) =>
          Boolean(host.querySelector("blockquote li strong")),
      },
      {
        name: "unclosed math and unsafe markup",
        prefix: padding + "\\[\\frac{a}{b}",
        tail: '\\]\n\n<img src=x onerror="alert(1)">\n\n![remote](https://remote.invalid/x.png)\n\n[bad](javascript:alert%281%29)',
        check: (host: HTMLElement) =>
          Boolean(
            host.querySelector(".katex-display") &&
              !host.querySelector("img, script, [href^='javascript:']"),
          ),
      },
      {
        name: "unlabelled fence closure",
        prefix: padding + "```\nfirst line\n  indented",
        tail: "\nlast line\n```",
        check: (host: HTMLElement) =>
          host.querySelector(".code-block code")?.textContent ===
          "first line\n  indented\nlast line",
      },
    ];
    const results = [];
    for (const item of cases) {
      const host = document.getElementById("root")!;
      const root = createRoot(host);
      flushSync(() =>
        root.render(createElement(RichText, { text: item.prefix })),
      );
      await rendered(host);
      const text = item.prefix + item.tail;
      flushSync(() => root.render(createElement(RichText, { text })));
      await rendered(host);
      const streamed = host.innerHTML;
      const correct = item.check(host);
      flushSync(() => root.unmount());
      const fresh = createRoot(host);
      flushSync(() => fresh.render(createElement(RichText, { text })));
      await rendered(host);
      results.push({
        name: item.name,
        correct,
        equivalent: streamed === host.innerHTML,
      });
      flushSync(() => fresh.unmount());
    }
    return results;
  },
  async benchmarkRichText(kind: "mixed" | "plain", size: number) {
    const host = document.getElementById("root")!;
    const root = createRoot(host);
    const unit = kind === "mixed" ? mixed : plain;
    const prefix = unit.repeat(Math.ceil(size / unit.length));
    const commit: number[] = [];
    const layout: number[] = [];
    const richLatency: number[] = [];
    const frameGaps: number[] = [];
    let text = prefix;
    flushSync(() => root.render(createElement(RichText, { text })));
    await document.fonts.ready;
    await rendered(host);
    for (let index = 0; index < 12; index++) {
      await frame();
      text = prefix + "\n\nStreaming tail " + "token ".repeat(index + 1);
      const start = performance.now();
      flushSync(() => root.render(createElement(RichText, { text })));
      const committed = performance.now();
      void host.offsetHeight;
      const laidOut = performance.now();
      const largestGap = await rendered(host, start);
      void host.offsetHeight;
      const richCompleted = performance.now();
      if (index >= 3) {
        commit.push(committed - start);
        layout.push(laidOut - start);
        richLatency.push(richCompleted - start);
        frameGaps.push(largestGap);
      }
    }
    const streamed = host.innerHTML;
    flushSync(() => root.unmount());
    const fresh = createRoot(host);
    flushSync(() => fresh.render(createElement(RichText, { text })));
    await rendered(host);
    const equivalent = streamed === host.innerHTML;
    flushSync(() => fresh.unmount());
    const median = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    return {
      kind,
      bytes: prefix.length,
      equivalent,
      commitMedianMs: median(commit),
      layoutMedianMs: median(layout),
      richLatencyMedianMs: median(richLatency),
      frameGapMedianMs: median(frameGaps),
      commitMs: commit,
      layoutMs: layout,
      richLatencyMs: richLatency,
      frameGapMs: frameGaps,
    };
  },
});
