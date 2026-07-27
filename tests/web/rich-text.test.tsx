// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RichText } from "../../src/components/RichText";

describe("formula rendering", () => {
  it("renders inline mathematics through KaTeX", () => {
    const { container } = render(<RichText text="The energy is $E=mc^2$ here." />);
    expect(container.querySelector(".katex")).toBeTruthy();
    expect(container.textContent).toContain("The energy is");
  });

  it("renders display mathematics", () => {
    const { container } = render(<RichText text={"Before\n\n$$\\int_0^1 x^2\\,dx=\\frac13$$\n\nAfter"} />);
    expect(container.querySelector(".katex-display")).toBeTruthy();
  });

  it("renders the project name expression ins$\\pi$re", () => {
    const { container } = render(<RichText text="ins$\pi$re" />);
    expect(container.querySelector(".katex")).toBeTruthy();
    expect(container.textContent).toContain("ins");
    expect(container.textContent).toContain("re");
  });

  it("keeps a KaTeX failure contained and the source readable", () => {
    const { container } = render(<RichText text={"$\\def\\bad{策划}$"} />);
    // throwOnError is false: the raw source stays visible inside the error span
    expect(container.textContent).toContain("\\def\\bad");
  });
});

describe("raw HTML and unsafe URL defense", () => {
  it("never parses raw HTML from model content", () => {
    const html = 'Look <img src="x" onerror="window.__pwned = 1"> here';
    const { container } = render(<RichText text={html} />);
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(container.textContent).toContain("Look");
  });

  it("does not render script tags", () => {
    const { container } = render(<RichText text={'before <script>window.__script = 1</script> after'} />);
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__script).toBeUndefined();
  });

  it("strips javascript: URLs from links", () => {
    const { container } = render(<RichText text="[click me](javascript:window.__js=1)" />);
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__js).toBeUndefined();
  });

  it("keeps safe https links with safe rel attributes", () => {
    render(<RichText text="[Pi docs](https://pi.dev)" />);
    const link = screen.getByRole("link", { name: "Pi docs" });
    expect(link).toHaveAttribute("href", "https://pi.dev");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders remote markdown images as links instead of fetching them", () => {
    const { container } = render(<RichText text="![tracking pixel](https://attacker.invalid/pixel.png)" />);
    // No <img>: rendering a message must not fire a request to an
    // attacker-chosen host. The reference stays reachable by choice.
    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: /tracking pixel/ });
    expect(link).toHaveAttribute("href", "https://attacker.invalid/pixel.png");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });
});

describe("local file references", () => {
  it("marks local Markdown links as file references without external-link behavior", () => {
    render(<RichText text="See [the report](./out/report.pdf) for details." />);
    const link = screen.getByRole("link", { name: "the report" });
    expect(link).toHaveAttribute("data-file-path", "./out/report.pdf");
    expect(link).not.toHaveAttribute("target");
    expect(link).not.toHaveAttribute("rel");
  });

  it("marks absolute and file: URL links as file references", () => {
    render(<RichText text="[log](/tmp/run.log) and [chart](file:///tmp/chart.png)" />);
    expect(screen.getByRole("link", { name: "log" })).toHaveAttribute("data-file-path", "/tmp/run.log");
    expect(screen.getByRole("link", { name: "chart" })).toHaveAttribute("data-file-path", "file:///tmp/chart.png");
  });

  it("keeps http(s) and mailto links as safe external links", () => {
    render(<RichText text="[Pi](https://pi.dev) [mail](mailto:a@b.c) [paper](http://x.test/p.pdf)" />);
    for (const name of ["Pi", "mail", "paper"]) {
      const link = screen.getByRole("link", { name });
      expect(link).not.toHaveAttribute("data-file-path");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer noopener");
    }
  });

  it("makes local images open the preview and remote images click-through links", () => {
    const { container } = render(<RichText text="![chart](./chart.png) and ![logo](https://pi.dev/logo.png)" />);
    const local = screen.getByRole("button", { name: "Preview chart" });
    expect(local).toHaveAttribute("data-file-path", "./chart.png");
    // Remote images never auto-load; the reference becomes an explicit link.
    expect(container.querySelector("img")).toBeNull();
    const remote = screen.getByRole("link", { name: /logo/ });
    expect(remote).toHaveAttribute("href", "https://pi.dev/logo.png");
    expect(remote.closest("[data-file-path]")).toBeNull();
  });

  it("makes credible inline-code paths clickable without touching ordinary code", () => {
    const { container } = render(<RichText text="Edit `src/store.ts` then run `npm test`." />);
    const ref = container.querySelector('[data-file-path="src/store.ts"]');
    expect(ref).toBeTruthy();
    expect(ref!.textContent).toBe("src/store.ts");
    expect(container.querySelector('[data-file-path="npm test"]')).toBeNull();
  });
});

describe("markdown constructs", () => {
  it("renders GFM tables and task lists", () => {
    const text = "| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo";
    const { container } = render(<RichText text={text} />);
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("renders fenced code with a language label and copy control", () => {
    const { container } = render(<RichText text={"```python\nprint(1)\n```"} />);
    expect(container.querySelector(".code-block__lang")?.textContent).toBe("python");
    expect(container.querySelector("code.hljs")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });
});
