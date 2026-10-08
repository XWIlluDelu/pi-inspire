// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GitDiffResponse,
  GitStatusResponse,
} from "../../shared/contracts";
import { createInitialAppState } from "../../src/app-state";
import { ChangesPane } from "../../src/components/ChangesPane";
import { selectContextPaneView } from "../../src/components/context-pane-view";

const clean: GitStatusResponse = {
  kind: "repository",
  head: { kind: "branch", name: "main", oid: "abc" },
  files: [],
  total: 0,
  truncated: false,
  groups: { staged: [], unstaged: [], untracked: [], conflicted: [] },
};
const changed: GitStatusResponse = {
  ...clean,
  files: [
    {
      path: { id: "notes", display: "notes.md", utf8Path: "notes.md" },
      unstaged: { kind: "modified" },
      untracked: false,
    },
  ],
  total: 1,
  groups: { ...clean.groups, unstaged: ["notes"] },
};
const staleNotice = "Refresh failed; showing the last known status.";
const initial = selectContextPaneView(createInitialAppState());

afterEach(cleanup);

describe("Changes source rendering", () => {
  it("renders highlighted source without changing line text or row geometry", () => {
    const result: GitDiffResponse = {
      kind: "text",
      path: changed.files[0].path,
      side: "unstaged",
      additions: 1,
      deletions: 1,
      truncated: true,
      encodingLossy: false,
      lines: [
        { kind: "delete", text: "-# Old heading", oldLine: 1, newLine: null },
        { kind: "add", text: "+# New heading", oldLine: null, newLine: 1 },
        {
          kind: "context",
          text: " <script>&</script>",
          oldLine: 2,
          newLine: 2,
        },
      ],
    };
    const { container } = render(
      <ChangesPane
        state={{
          ...initial,
          gitStatus: changed,
          selectedGitPathId: "notes",
          selectedGitSide: "unstaged",
          gitDiff: { status: "ready", result },
        }}
      />,
    );
    const rowIcon = screen
      .getByRole("button", { name: "notes.md, unstaged modified" })
      .querySelector("svg");
    expect(rowIcon).toHaveClass("lucide-file-text");
    expect(rowIcon).toHaveAttribute("aria-hidden", "true");
    expect(rowIcon).toHaveAttribute("width", "13");
    const rows = container.querySelectorAll(".source-diff__line");
    expect(rows).toHaveLength(3);
    expect(
      [...rows].map((row) => row.querySelector("code")?.textContent),
    ).toEqual(["# Old heading", "# New heading", "<script>&</script>"]);
    expect(rows[0].querySelector(".hljs-section")).not.toBeNull();
    expect(rows[1].querySelector(".hljs-section")).not.toBeNull();
    const gutter = rows[0].querySelector(".source-diff__gutter");
    expect(gutter).toHaveAttribute("aria-hidden", "true");
    expect(gutter?.querySelectorAll(".source-diff__number")).toHaveLength(2);
    expect(gutter?.querySelector(".source-diff__mark")).toHaveTextContent("−");
    expect(rows[1].querySelector(".source-diff__mark")).toHaveTextContent("+");
    expect(rows[2].querySelector("script")).toBeNull();
    expect(screen.getByText("Source truncated")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Next change" }),
    ).not.toBeDisabled();
  });
});

describe("Changes status observation", () => {
  it("distinguishes initial loading and failure from retained results", () => {
    const { rerender } = render(
      <ChangesPane state={{ ...initial, gitStatusLoading: true }} />,
    );
    expect(screen.getByText("Reading Git status")).toBeInTheDocument();
    expect(screen.queryByText(staleNotice)).toBeNull();

    rerender(
      <ChangesPane state={{ ...initial, gitStatusError: "Git timed out" }} />,
    );
    expect(screen.getByText("Git status unavailable")).toBeInTheDocument();
    expect(screen.getByText("Git timed out")).toBeInTheDocument();
    expect(screen.queryByText(staleNotice)).toBeNull();
    expect(
      screen.queryByText(/Working tree clean|No Git repository/),
    ).toBeNull();
  });

  it.each([
    { status: clean, title: "Working tree clean" },
    {
      status: { kind: "not-repository" } as GitStatusResponse,
      title: "No Git repository",
    },
    { status: changed, title: "notes.md, unstaged modified" },
  ])(
    "retains $title with one stale-result warning after a failed refresh",
    ({ status, title }) => {
      const state = { ...initial, gitStatus: status };
      const { rerender, container } = render(<ChangesPane state={state} />);
      expect(screen.queryByText(staleNotice)).toBeNull();

      rerender(
        <ChangesPane state={{ ...state, gitStatusError: "Git timed out" }} />,
      );
      expect(screen.getByText(staleNotice)).toHaveAttribute("role", "status");
      expect(container.textContent?.match(/last known/g)).toHaveLength(1);
      if (status === changed) {
        expect(screen.getByRole("button", { name: title })).toBeInTheDocument();
      } else {
        expect(screen.getByText(title)).toBeInTheDocument();
      }
      if (status === clean) {
        expect(
          container.querySelector(".res__index-summary"),
        ).toHaveTextContent(/^Clean$/);
      }

      rerender(<ChangesPane state={state} />);
      expect(screen.queryByText(staleNotice)).toBeNull();
      if (status !== changed)
        expect(screen.getByText(title)).toBeInTheDocument();
      if (status === clean) {
        expect(
          container.querySelector(".res__index-summary"),
        ).toHaveTextContent(/^Clean$/);
      }
    },
  );
});
