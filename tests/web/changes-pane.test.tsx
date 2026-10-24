// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitDiffResponse,
  GitStatusResponse,
} from "../../shared/contracts";
import { createInitialAppState } from "../../src/app-state";
import {
  ChangesPane,
  type ChangesReadingPositions,
} from "../../src/components/ChangesPane";
import { selectContextPaneView } from "../../src/components/context-pane-view";
import { store } from "../../src/store";

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("narrow Changes navigation", () => {
  it("visits each indexed comparison, including both sides, and restores the list's focus and scroll", () => {
    const open = vi.spyOn(store, "openGitDiff").mockResolvedValue();
    const back = vi
      .spyOn(store, "showChangesBrowser")
      .mockImplementation(() => {});
    const status: GitStatusResponse = {
      ...changed,
      total: 2,
      files: [
        { ...changed.files[0], staged: { kind: "modified" } },
        {
          path: { id: "other", display: "other.ts", utf8Path: "other.ts" },
          unstaged: { kind: "deleted" },
          untracked: false,
        },
      ],
    };
    const state = { ...initial, sessionId: "s1", gitStatus: status };
    const view = render(<ChangesPane state={state} narrow />);
    const list = view.container.querySelector<HTMLElement>(".res__list")!;
    list.scrollTop = 80;
    const next = () => screen.getByRole("button", { name: "Next file change" });
    const previous = () =>
      screen.getByRole("button", { name: "Previous file change" });
    expect(
      screen.queryByRole("button", { name: "Next file change" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "notes.md, unstaged modified" }),
    );
    expect(open).toHaveBeenLastCalledWith("notes", "unstaged");
    view.rerender(
      <ChangesPane
        state={{
          ...state,
          selectedGitPathId: "notes",
          selectedGitSide: "unstaged",
        }}
        narrow
      />,
    );
    expect(
      screen.getByRole("button", { name: "All changes (2)" }),
    ).toHaveFocus();
    expect(list.closest(".res__index")).toHaveAttribute("hidden");
    expect(previous()).toBeDisabled();
    expect(screen.getByText("Working 1/3")).toBeInTheDocument();
    fireEvent.click(next());
    expect(open).toHaveBeenLastCalledWith("other", "unstaged");

    view.rerender(
      <ChangesPane
        state={{
          ...state,
          selectedGitPathId: "other",
          selectedGitSide: "unstaged",
        }}
        narrow
      />,
    );
    fireEvent.click(next());
    expect(open).toHaveBeenLastCalledWith("notes", "staged");
    view.rerender(
      <ChangesPane
        state={{
          ...state,
          selectedGitPathId: "notes",
          selectedGitSide: "staged",
        }}
        narrow
      />,
    );
    expect(screen.getByText("Staged 3/3")).toBeInTheDocument();
    expect(next()).toBeDisabled();
    fireEvent.click(previous());
    expect(open).toHaveBeenLastCalledWith("other", "unstaged");

    fireEvent.click(screen.getByRole("button", { name: "All changes (2)" }));
    expect(back).toHaveBeenCalledOnce();
    view.rerender(<ChangesPane state={state} narrow />);
    expect(
      screen.getByRole("button", { name: "notes.md, staged modified" }),
    ).toHaveFocus();
    expect(list.scrollTop).toBe(80);
    expect(view.container.querySelector(".res__body--detail")).toBeNull();
  });
});

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

describe("Changes reading continuity", () => {
  it("restores offsets and navigation across reloads and pane remounts without mixing scopes or sides", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callback();
      return 0;
    });
    const result: GitDiffResponse = {
      kind: "text",
      path: changed.files[0].path,
      side: "unstaged",
      additions: 2,
      deletions: 2,
      truncated: false,
      encodingLossy: false,
      lines: [
        { kind: "delete", text: "-old", oldLine: 1, newLine: null },
        { kind: "add", text: "+new", oldLine: null, newLine: 1 },
        { kind: "context", text: " same", oldLine: 2, newLine: 2 },
        { kind: "delete", text: "-old", oldLine: 3, newLine: null },
        { kind: "add", text: "+new", oldLine: null, newLine: 3 },
      ],
    };
    const state = {
      ...initial,
      sessionId: "session",
      cwd: "/project",
      gitStatus: changed,
      selectedGitPathId: "notes",
      selectedGitSide: "unstaged" as const,
      gitDiff: { status: "ready" as const, result },
    };
    const positions: ChangesReadingPositions = new Map();
    const view = render(
      <ChangesPane state={state} readingPositions={positions} />,
    );
    const source = () =>
      screen.getByRole("region", { name: "Source changes for notes.md" });
    source().scrollTop = 300;
    source().scrollLeft = 20;
    fireEvent.scroll(source());
    const originalReader = source();
    view.rerender(
      <ChangesPane state={state} readingPositions={positions} narrow />,
    );
    expect(source()).toBe(originalReader);
    expect(source().scrollTop).toBe(300);
    expect(source().scrollLeft).toBe(20);
    expect(view.container.querySelector(".res__index")).toHaveAttribute(
      "hidden",
    );
    expect(
      screen.getByRole("button", { name: "All changes (1)" }),
    ).toHaveFocus();
    view.rerender(<ChangesPane state={state} readingPositions={positions} />);
    expect(source()).toBe(originalReader);
    expect(view.container.querySelector(".res__index")).not.toHaveAttribute(
      "hidden",
    );
    expect(
      screen.queryByRole("button", { name: "All changes (1)" }),
    ).toBeNull();
    expect(view.container.querySelector(".changes__content")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    const updated = {
      ...state,
      gitDiff: {
        status: "ready" as const,
        result: {
          ...result,
          lines: result.lines.map((line) =>
            line.kind === "add" ? { ...line, text: "+latest" } : line,
          ),
        },
      },
    };
    view.rerender(<ChangesPane state={updated} readingPositions={positions} />);
    expect(source()).toHaveTextContent("latest");
    expect(source().scrollTop).toBe(300);
    view.rerender(
      <ChangesPane
        state={{
          ...updated,
          gitDiff: { ...updated.gitDiff, refreshError: "Repository busy" },
        }}
        readingPositions={positions}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Source refresh failed; showing the last known source. Repository busy",
    );
    expect(source()).toHaveTextContent("latest");
    view.rerender(<ChangesPane state={state} readingPositions={positions} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(source().scrollTop).toBe(300);
    expect(source().scrollLeft).toBe(20);
    expect(
      source().querySelectorAll(".source-diff__line--active"),
    ).toHaveLength(2);

    for (const scope of [
      { sessionId: "another session" },
      { cwd: "/another project" },
      { transportGeneration: state.transportGeneration + 1 },
      {
        gitDiff: {
          status: "ready" as const,
          result: { ...result, side: "staged" as const },
        },
      },
    ]) {
      view.rerender(
        <ChangesPane
          state={{ ...state, ...scope }}
          readingPositions={positions}
        />,
      );
      expect(source().scrollTop).toBe(0);
      expect(source().scrollLeft).toBe(0);
      expect(source().querySelector(".source-diff__line--active")).toBeNull();
    }
    view.unmount();
    render(<ChangesPane state={state} readingPositions={positions} />);
    expect(source().scrollTop).toBe(300);
    expect(source().scrollLeft).toBe(20);
    expect(
      source().querySelectorAll(".source-diff__line--active"),
    ).toHaveLength(2);
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

describe("filesystem selection is not Git evidence", () => {
  it.each([
    [null, null, "Git status unavailable"],
    [clean, "failed", "Git status unavailable"],
    [{ kind: "not-repository" }, null, "Not in a Git repository"],
    [{ ...clean, truncated: true, total: 1001 }, null, "Git status incomplete"],
    [clean, null, "No Git comparison"],
  ] as const)(
    "does not turn an absent status entry into zero changes (%s, %s)",
    (gitStatus, gitStatusError, label) => {
      render(
        <ChangesPane
          state={{
            ...initial,
            selectedResourceReference: "output/report.txt",
            gitStatus,
            gitStatusError,
            selectedGitPathId: null,
            selectedGitSide: null,
            gitDiff: null,
          }}
        />,
      );
      expect(screen.getByLabelText(label)).toHaveTextContent("——");
      expect(screen.queryByText("+0")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Copy path/ }),
      ).toBeInTheDocument();
    },
  );

  it("does not substitute filesystem source for a vanished staged comparison", () => {
    const path = {
      id: "file",
      display: "source.ts",
      utf8Path: "source.ts",
      workspacePath: "source.ts",
    };
    render(
      <ChangesPane
        state={{
          ...initial,
          gitStatus: {
            ...clean,
            files: [{ path, untracked: false, staged: { kind: "modified" } }],
          },
          selectedGitPathId: path.id,
          selectedGitSide: "staged",
          gitDiff: {
            status: "ready",
            result: {
              path,
              side: "staged",
              kind: "empty",
              reason: "no-changes",
            },
          },
        }}
      />,
    );
    expect(screen.getByText("No diff available")).toBeInTheDocument();
  });
});
