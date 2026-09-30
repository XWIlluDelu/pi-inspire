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

async function frame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

// Measures production React's synchronous render+commit separately from the
// following forced layout. No Host, mock API, transport, or app runtime involved.
Object.assign(window, {
  async benchmarkRichText(kind: "mixed" | "plain", size: number) {
    const host = document.getElementById("root")!;
    const root = createRoot(host);
    const unit = kind === "mixed" ? mixed : plain;
    const prefix = unit.repeat(Math.ceil(size / unit.length));
    const commit: number[] = [];
    const layout: number[] = [];
    let text = prefix;
    flushSync(() => root.render(createElement(RichText, { text })));
    await document.fonts.ready;
    for (let index = 0; index < 12; index++) {
      await frame();
      text = prefix + "\n\nStreaming tail " + "token ".repeat(index + 1);
      const start = performance.now();
      flushSync(() => root.render(createElement(RichText, { text })));
      const committed = performance.now();
      void host.offsetHeight;
      const laidOut = performance.now();
      if (index >= 3) {
        commit.push(committed - start);
        layout.push(laidOut - start);
      }
    }
    const streamed = host.innerHTML;
    flushSync(() => root.unmount());
    const fresh = createRoot(host);
    flushSync(() => fresh.render(createElement(RichText, { text })));
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
      commitMs: commit,
      layoutMs: layout,
    };
  },
});
