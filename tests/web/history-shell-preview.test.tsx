// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fencedMarkdown } from "../../shared/markdown-fence";
import { HistoryShellPreview } from "../../src/components/HistoryShellPreview";

afterEach(() => vi.unstubAllGlobals());

const record = (output: string, path?: string) =>
  [
    fencedMarkdown("!printf 'shell history'", ""),
    fencedMarkdown(output, ""),
    "Exit 0",
    "Included in context",
    ...(path ? ["Output truncated", `Full output: ${path}`] : []),
  ].join("\n\n");

describe("plain shell History", () => {
  it("preserves literal stdout and copies the loaded record without executable code controls", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const output =
      "# Not a heading\n  column A\tcolumn B\n- [x] **literal**\n<script>not executable</script>\n```js\nraw code\n```\n\u001b[31mred\u001b[0m";
    render(<HistoryShellPreview text={record(output)} complete />);
    const preview = screen.getByRole("region", {
      name: "Shell record preview",
    });
    expect(
      preview.querySelector(".history-shell__output")!.textContent,
    ).toContain(output.replace(/\u001b\[[0-9;]*m/g, ""));
    expect(preview.querySelector("script")).toBeNull();
    expect(
      preview.querySelector(".history-shell__output"),
    ).not.toHaveTextContent("Included in context");
    expect(preview).toHaveTextContent("Included in context");
    expect(preview.querySelector(".history-shell__header")).toContainElement(
      screen.getByRole("button", { name: "Copy loaded shell content" }),
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Insert.*terminal/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Copy loaded shell content" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        [
          "!printf 'shell history'",
          output,
          "Exit 0",
          "Included in context",
        ].join("\n\n"),
      ),
    );
  });

  it("keeps paged output literal and exposes only the complete Host-projected full-log reference", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const output = "column A\tcolumn B\n".repeat(2500);
    const text = record(output, "/tmp/logs/native shell.log");
    const view = render(
      <HistoryShellPreview text={text.slice(0, 32000)} complete={false} />,
    );
    expect(
      screen.queryByRole("button", { name: "View full shell output" }),
    ).toBeNull();
    expect(
      screen.getByRole("region").querySelector(".history-shell__output")!
        .textContent,
    ).toContain("column A\tcolumn B");
    view.rerender(<HistoryShellPreview text={text} complete />);
    expect(
      screen.getByRole("region").querySelector(".history-shell__output")!
        .textContent,
    ).toContain(output);
    expect(
      screen.getByRole("button", { name: "View full shell output" }),
    ).toHaveAttribute("data-file-path", "/tmp/logs/native shell.log");
    expect(
      screen.getByRole("button", { name: "View full shell output" }),
    ).toHaveAttribute("title", "Preview /tmp/logs/native shell.log");
    expect(screen.getByRole("region")).not.toHaveTextContent(
      "/tmp/logs/native shell.log",
    );
    expect(
      screen.getByRole("region").querySelector(".history-shell__output"),
    ).not.toHaveTextContent("Exit 0");
    fireEvent.click(
      screen.getByRole("button", { name: "Copy loaded shell content" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        [
          "!printf 'shell history'",
          output,
          "Exit 0",
          "Included in context",
          "Output truncated",
          "Full output: /tmp/logs/native shell.log",
        ].join("\n\n"),
      ),
    );
  });

  it("separates Host metadata without lifting status-like text out of stdout", () => {
    const output = "Exit 99\n\nIncluded in context\n\nOutput truncated";
    render(<HistoryShellPreview text={record(output)} complete />);
    const preview = screen.getByRole("region", {
      name: "Shell record preview",
    });
    expect(preview.querySelector(".history-shell__command")!.textContent).toBe(
      "!printf 'shell history'",
    );
    expect(preview.querySelector(".history-shell__output")!.textContent).toBe(
      output,
    );
    expect(
      Array.from(
        preview.querySelectorAll(
          ".history-shell__facts > span:not(.history-shell__kind)",
        ),
        (node) => node.textContent,
      ),
    ).toEqual(["Exit 0", "Included in context"]);
  });

  it.each([
    ["Exit 0", "success"],
    ["Exit 7", "error"],
    ["Cancelled", "warning"],
    ["Finished", null],
  ])("presents the Host outcome %s in the header", (status, outcome) => {
    render(
      <HistoryShellPreview
        text={record("Exit 99").replace("Exit 0", status)}
        complete
      />,
    );
    const header = screen
      .getByRole("region")
      .querySelector(".history-shell__header")!;
    const label = screen.getByText(status);
    expect(header).toContainElement(label);
    if (outcome) expect(label).toHaveAttribute("data-outcome", outcome);
    else expect(label).not.toHaveAttribute("data-outcome");
    expect(header).toHaveTextContent("Included in context");
    expect(
      screen.getByRole("region").querySelector(".history-shell__footer"),
    ).toBeNull();
  });

  it("omits an empty output field without removing the command or outcomes", () => {
    render(<HistoryShellPreview text={record("")} complete />);
    expect(
      screen.getByRole("region").querySelector(".history-shell__command"),
    ).toHaveTextContent("!printf 'shell history'");
    expect(
      screen.getByRole("region").querySelector(".history-shell__output"),
    ).toBeNull();
    expect(screen.getByText("Exit 0")).toHaveAttribute(
      "data-outcome",
      "success",
    );
  });

  it("never treats a path printed inside stdout or unfinished metadata as a full-log field", () => {
    const output = "Full output: /tmp/stdout-is-not-metadata.log";
    const view = render(<HistoryShellPreview text={record(output)} complete />);
    expect(
      screen.queryByRole("button", { name: "View full shell output" }),
    ).toBeNull();
    view.rerender(
      <HistoryShellPreview
        text={record("log", "/tmp/unfinished-path")}
        complete={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "View full shell output" }),
    ).toBeNull();
    expect(screen.getByRole("region")).toHaveTextContent(
      "Full output: /tmp/unfinished-path",
    );
  });
});
