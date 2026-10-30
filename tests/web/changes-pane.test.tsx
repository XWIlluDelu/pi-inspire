// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitDiffResponse,
  GitStatusResponse,
} from "../../shared/contracts";
import { createInitialAppState } from "../../src/app-state";
import { ChangesDetail, ChangesPane } from "../../src/components/ChangesPane";
import type { ContextPaneView } from "../../src/components/context-pane-view";
import { selectContextPaneView } from "../../src/components/context-pane-view";
import { store } from "../../src/store";
import type { FileReadingState } from "../../src/workbench-session";

const clean: Extract<GitStatusResponse, { kind: "repository" }> = {
  kind: "repository",
  head: { kind: "branch", name: "main", oid: "abc" },
  files: [],
  total: 0,
  truncated: false,
  groups: { staged: [], unstaged: [], untracked: [], conflicted: [] },
};
const changed: Extract<GitStatusResponse, { kind: "repository" }> = {
  ...clean,
  files: [
    {
      path: { id: "notes", display: "notes.md", utf8Path: "notes.md" },
      worktree: { kind: "modified" },
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

function Detail({
  state,
  readingState,
}: {
  state: ContextPaneView;
  readingState?: FileReadingState;
}) {
  return (
    <ChangesDetail
      state={state}
      readingState={readingState}
      render={(controls, content) => (
        <>
          <div>{controls}</div>
          <div className="file-preview__content">{content}</div>
        </>
      )}
    />
  );
}
const diff: Extract<GitDiffResponse, { kind: "text" }> = {
  kind: "text",
  path: changed.files[0].path,
  side: "worktree",
  additions: 2,
  deletions: 2,
  truncated: false,
  encodingLossy: false,
  lines: [
    { kind: "delete", text: "-# Old heading", oldLine: 1, newLine: null },
    { kind: "add", text: "+# New heading", oldLine: null, newLine: 1 },
    { kind: "context", text: " <script>&</script>", oldLine: 2, newLine: 2 },
    { kind: "delete", text: "-old", oldLine: 3, newLine: null },
    { kind: "add", text: "+new", oldLine: null, newLine: 3 },
  ],
};
function ready(result = diff): ContextPaneView {
  return {
    ...initial,
    sessionId: "session",
    cwd: "/project",
    gitStatus: {
      ...changed,
      files: [{ ...changed.files[0], staged: { kind: "modified" } }],
    },
    selectedGitPathId: result.path.id,
    selectedGitSide: result.side,
    gitDiff: { status: "ready", result },
  };
}
function readings(): FileReadingState {
  return {
    source: { current: null },
    rendered: { current: null },
    changes: {},
    save: vi.fn(),
  };
}

describe("Changes file list", () => {
  it("keeps a full list when a file is selected and restores its scroll on return", () => {
    const open = vi.spyOn(store, "openGitDiff").mockResolvedValue();
    const browseScrollTop = { current: 70 };
    const state = ready();
    const view = render(
      <ChangesPane state={state} browseScrollTop={browseScrollTop} />,
    );
    const list = view.container.querySelector<HTMLElement>(".res__list")!;
    expect(list.scrollTop).toBe(70);
    expect(view.container.querySelector(".changes__detail")).toBeNull();
    expect(screen.queryByRole("region", { name: /Source changes/ })).toBeNull();
    expect(screen.queryByText("Select a change")).toBeNull();
    expect(open).not.toHaveBeenCalled();
    const row = screen.getByRole("button", {
      name: "notes.md, modified",
    });
    expect(row.querySelector("svg")).toHaveClass("lucide-file-text");
    fireEvent.click(row);
    expect(open).toHaveBeenLastCalledWith("notes", "worktree");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(
      screen.queryByRole("heading", { name: /Staged|Unstaged/ }),
    ).toBeNull();
    expect(
      view.container.querySelector(".res__index-summary"),
    ).toHaveTextContent("1 change");
    list.scrollTop = 150;
    view.unmount();
    const returned = render(
      <ChangesPane state={state} browseScrollTop={browseScrollTop} />,
    );
    expect(returned.container.querySelector(".res__list")?.scrollTop).toBe(150);
  });
});

describe("File Changes rendering and navigation", () => {
  it("retains escaped highlighted source and exposes bounded hunk navigation within the file", () => {
    const open = vi.spyOn(store, "openGitDiff").mockResolvedValue();
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callback();
      return 0;
    });
    const { container } = render(
      <Detail state={ready({ ...diff, truncated: true })} />,
    );
    const rows = container.querySelectorAll(".source-diff__line");
    expect(
      [...rows].map((row) => row.querySelector("code")?.textContent),
    ).toEqual([
      "# Old heading",
      "# New heading",
      "<script>&</script>",
      "old",
      "new",
    ]);
    expect(rows[0].querySelector(".hljs-section")).not.toBeNull();
    expect(rows[2].querySelector("script")).toBeNull();
    expect(rows[0].querySelector(".source-diff__gutter")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(rows[0].querySelector(".source-diff__mark")).toHaveTextContent("−");
    expect(screen.getByText("Source truncated")).toBeInTheDocument();
    expect(screen.getByLabelText("Change position")).toHaveTextContent("1/2");
    expect(
      screen.getByRole("button", { name: "Previous change" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(screen.getByLabelText("Change position")).toHaveTextContent("2/2");
    expect(screen.getByRole("button", { name: "Next change" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous change" }));
    expect(screen.getByLabelText("Change position")).toHaveTextContent("1/2");
    expect(open).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("combobox", { name: "Comparison side" }),
    ).toBeNull();
  });

  it("retains reading across refresh and remount, and resets stale counters during another file selection", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callback();
      return 0;
    });
    const readingState = readings();
    const state = ready();
    const view = render(<Detail state={state} readingState={readingState} />);
    const source = () =>
      screen.getByRole("region", { name: "Source changes for notes.md" });
    source().scrollTop = 300;
    source().scrollLeft = 20;
    fireEvent.scroll(source());
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    const updated = {
      ...state,
      gitDiff: {
        status: "ready" as const,
        result: {
          ...diff,
          lines: diff.lines.map((line) =>
            line.kind === "add" ? { ...line, text: "+latest" } : line,
          ),
        },
        refreshError: "Repository busy",
      },
    };
    view.rerender(<Detail state={updated} readingState={readingState} />);
    expect(source()).toHaveTextContent("latest");
    expect(source().scrollTop).toBe(300);
    expect(screen.getByText(/Source refresh failed/)).toHaveTextContent(
      "Source refresh failed",
    );
    expect(screen.getByLabelText("Change position")).toHaveTextContent("2/2");

    const otherPath = {
      id: "other",
      display: "other.md",
      utf8Path: "other.md",
    };
    const other = {
      ...ready({ ...diff, path: otherPath, lines: diff.lines.slice(0, 2) }),
      gitStatus: {
        ...changed,
        files: [{ ...changed.files[0], path: otherPath }],
      },
    };
    const otherReading = readings();
    view.rerender(
      <Detail
        state={{
          ...other,
          gitDiff: { status: "loading", pathId: "other", side: "worktree" },
        }}
        readingState={otherReading}
      />,
    );
    expect(screen.getByLabelText("Change position")).toHaveTextContent("—");
    expect(
      screen.getByRole("button", { name: "Previous change" }),
    ).toBeDisabled();
    expect(screen.queryByRole("region", { name: /Source changes/ })).toBeNull();
    view.rerender(<Detail state={other} readingState={otherReading} />);
    expect(
      screen.getByRole("region", { name: "Source changes for other.md" })
        .scrollTop,
    ).toBe(0);
    expect(screen.getByLabelText("Change position")).toHaveTextContent("1/1");
    view.rerender(<Detail state={state} readingState={readingState} />);
    expect(source().scrollTop).toBe(300);
    expect(source().scrollLeft).toBe(20);
    expect(screen.getByLabelText("Change position")).toHaveTextContent("2/2");
    view.unmount();
    render(<Detail state={state} readingState={readingState} />);
    expect(source().scrollTop).toBe(300);
    expect(screen.getByLabelText("Change position")).toHaveTextContent("2/2");
    expect(readingState.save).toHaveBeenCalled();
  });

  it("does not let a queued hunk jump target a newly selected file", () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callbacks.push(callback);
      return 0;
    });
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const state = ready();
    const view = render(<Detail state={state} readingState={readings()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    const otherPath = {
      id: "other",
      display: "other.md",
      utf8Path: "other.md",
    };
    view.rerender(
      <Detail
        state={{
          ...ready({ ...diff, path: otherPath }),
          gitStatus: {
            ...changed,
            files: [{ ...changed.files[0], path: otherPath }],
          },
        }}
        readingState={readings()}
      />,
    );
    callbacks.forEach((callback) => callback());
    expect(scroll).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Change position")).toHaveTextContent("1/2");
  });

  it("restores a file tab's reading after its Git selection resolves on remount", () => {
    const readingState = readings();
    readingState.changes = {
      worktree: { top: 800, left: 50, activeChange: 1 },
    };
    const state = { ...ready(), selectedResourceReference: "notes.md" };
    const view = render(
      <Detail
        state={{
          ...state,
          selectedGitPathId: null,
          selectedGitSide: null,
          gitDiff: null,
          gitStatusRefreshing: true,
        }}
        readingState={readingState}
      />,
    );
    expect(screen.queryByRole("region", { name: /Source changes/ })).toBeNull();
    expect(screen.getByLabelText("Change position")).toHaveTextContent("—");
    view.rerender(<Detail state={state} readingState={readingState} />);
    const source = screen.getByRole("region", {
      name: "Source changes for notes.md",
    });
    expect(source.scrollTop).toBe(800);
    expect(source.scrollLeft).toBe(50);
    expect(screen.getByLabelText("Change position")).toHaveTextContent("2/2");

    const otherPath = {
      id: "other",
      display: "other.md",
      utf8Path: "other.md",
    };
    view.rerender(
      <Detail
        state={{
          ...ready({ ...diff, path: otherPath }),
          selectedResourceReference: "other.md",
          gitStatus: {
            ...changed,
            files: [{ ...changed.files[0], path: otherPath }],
          },
        }}
        readingState={readingState}
      />,
    );
    const otherSource = screen.getByRole("region", {
      name: "Source changes for other.md",
    });
    expect(otherSource.scrollTop).toBe(0);
    expect(otherSource.scrollLeft).toBe(0);
    expect(screen.getByLabelText("Change position")).toHaveTextContent("1/2");
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
    { status: changed, title: "notes.md, modified" },
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

describe("Git evidence boundaries", () => {
  it.each(["gitStatusLoading", "gitStatusRefreshing"] as const)(
    "waits for %s before treating the previous clean status as no comparison",
    (pendingFlag) => {
      const state = { ...ready(), gitStatus: clean, gitDiff: null };
      const view = render(<Detail state={{ ...state, [pendingFlag]: true }} />);
      expect(screen.getByText("Reading Git status")).toBeInTheDocument();
      expect(screen.queryByText("No Git comparison")).toBeNull();
      expect(
        screen.getByRole("group", { name: "Reading Git status" }),
      ).toHaveTextContent("——");
      expect(screen.getByLabelText("Change position")).toHaveTextContent("—");
      expect(
        screen.getByRole("button", { name: "Next change" }),
      ).toBeDisabled();

      view.rerender(<Detail state={state} />);
      expect(screen.queryByText("Reading Git status")).toBeNull();
      expect(screen.getByText("No Git comparison")).toBeInTheDocument();
    },
  );

  it.each([
    { status: clean, label: "No Git comparison" },
    {
      status: { kind: "not-repository" } as GitStatusResponse,
      label: "Not in a Git repository",
    },
  ])(
    "retains $label during background observation without lending it to another scope",
    ({ status, label }) => {
      const state = {
        ...ready(),
        selectedResourceReference: "notes.md",
        gitStatus: status,
        gitDiff: null,
      };
      const view = render(<Detail state={state} />);
      const empty = screen.getByText(label);
      view.rerender(<Detail state={{ ...state, gitStatusRefreshing: true }} />);
      expect(screen.getByText(label)).toBe(empty);
      expect(screen.queryByText("Reading Git status")).toBeNull();
      expect(view.container.querySelector(".pi-loading")).toBeNull();
      expect(screen.getByRole("group", { name: label })).toHaveTextContent(
        "——",
      );
      for (const changedOwner of [
        { selectedResourceReference: "other.md" },
        { sessionId: "other-session" },
        { cwd: "/other" },
        { transportGeneration: state.transportGeneration + 1 },
      ]) {
        view.rerender(
          <Detail
            state={{ ...state, ...changedOwner, gitStatusRefreshing: true }}
          />,
        );
        expect(screen.getByText("Reading Git status")).toBeInTheDocument();
        expect(screen.queryByText(label)).toBeNull();
      }
      view.rerender(<Detail state={{ ...state, gitStatusRefreshing: true }} />);
      expect(screen.getByText("Reading Git status")).toBeInTheDocument();
      view.rerender(
        <Detail state={{ ...state, gitStatusError: "Git failed" }} />,
      );
      expect(screen.getByText("Git status unavailable")).toBeInTheDocument();
      view.rerender(<Detail state={state} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    },
  );

  it("keeps the current matching comparison visible during a background status refresh", () => {
    render(<Detail state={{ ...ready(), gitStatusRefreshing: true }} />);
    expect(
      screen.getByRole("region", { name: "Source changes for notes.md" }),
    ).toHaveTextContent("New heading");
    expect(screen.getByLabelText("Change position")).toHaveTextContent("1/2");
    expect(screen.queryByText("Reading Git status")).toBeNull();
    expect(screen.queryByText("No Git comparison")).toBeNull();
  });

  it.each([
    [null, null, "Git status unavailable"],
    [clean, "failed", "Git status unavailable"],
    [{ kind: "not-repository" }, null, "Not in a Git repository"],
    [{ ...clean, truncated: true, total: 1001 }, null, "Git status incomplete"],
    [clean, null, "No Git comparison"],
  ] as const)(
    "never shows a retained diff as current without Git evidence (%s, %s)",
    (gitStatus, gitStatusError, label) => {
      render(
        <Detail
          state={{
            ...ready(),
            gitStatus,
            gitStatusError,
            selectedGitPathId: null,
            selectedGitSide: null,
            resourcePreview: { status: "loading", reference: "notes.md" },
          }}
        />,
      );
      expect(screen.getByRole("group", { name: label })).toHaveTextContent(
        "——",
      );
      expect(screen.queryByText("+2")).toBeNull();
      expect(
        screen.queryByRole("region", { name: /Source changes/ }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Next change" }),
      ).toBeDisabled();
    },
  );

  it("does not substitute filesystem source for an empty comparison", () => {
    render(
      <Detail
        state={{
          ...ready(),
          selectedGitSide: "worktree",
          gitDiff: {
            status: "ready",
            result: {
              path: diff.path,
              side: "worktree",
              kind: "empty",
              reason: "no-changes",
            },
          },
        }}
      />,
    );
    expect(screen.getByText("No diff available")).toBeInTheDocument();
  });

  it("does not render a retained index comparison as the net worktree diff", () => {
    render(
      <Detail
        state={{
          ...ready(),
          gitDiff: { status: "ready", result: { ...diff, side: "staged" } },
        }}
      />,
    );
    expect(screen.getByText("Loading source")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Source changes/ })).toBeNull();
    expect(screen.getByLabelText("Change position")).toHaveTextContent("—");
  });
});
