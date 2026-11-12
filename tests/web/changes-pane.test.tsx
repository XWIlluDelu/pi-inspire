// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitDiffResponse,
  GitStatusResponse,
} from "../../shared/contracts";
import { createInitialAppState } from "../../src/app-state";
import { ChangesDetail, ChangesPane } from "../../src/components/ChangesPane";
import type { ContextPaneView } from "../../src/components/context-pane-view";
import { selectContextPaneView } from "../../src/components/context-pane-view";
import type { FileReadingState } from "../../src/workbench-session";

const clean: Extract<GitStatusResponse, { kind: "repository" }> = {
  kind: "repository",
  head: { kind: "branch", name: "main", oid: "abc" },
  files: [],
  total: 0,
  truncated: false,
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
};
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
function ready(result: GitDiffResponse = diff): ContextPaneView {
  const { id, display, utf8Path } = result.path;
  const reference = utf8Path ?? display;
  return {
    ...initial,
    sessionId: "session",
    cwd: "/project",
    gitStatus: {
      ...changed,
      files: [{ ...changed.files[0], path: result.path }],
    },
    fileInspection: { kind: "file", reference, preview: null },
    resourceTabs: [
      {
        reference,
        view: "changes",
        git: { pathId: id, displayPath: reference },
      },
    ],
    gitDiff: { status: "ready", result },
  };
}
function readings(): FileReadingState {
  return {
    source: { current: null },
    rendered: { current: null },
    save: vi.fn(),
  };
}

it("distinguishes initial Git status loading and failure", () => {
  const view = render(
    <ChangesPane state={{ ...initial, gitStatusLoading: true }} />,
  );
  expect(screen.getByText("Reading Git status")).toBeVisible();
  view.rerender(
    <ChangesPane state={{ ...initial, gitStatusError: "Git timed out" }} />,
  );
  expect(screen.getByText("Git status unavailable")).toBeVisible();
});

describe("File Changes rendering and navigation", () => {
  const path = diff.path;
  const nonTextChanges: [string, GitDiffResponse, string][] = [
    ["Binary change", { kind: "binary", path }, "no line-based source view"],
    [
      "No diff available",
      { kind: "empty", path, reason: "no-changes" },
      "Git no longer reports this comparison",
    ],
    [
      "Unresolved conflict",
      { kind: "conflict", path, code: "UU" },
      "Conflict state UU",
    ],
    [
      "Submodule change",
      {
        kind: "submodule",
        path,
        state: {
          commitChanged: true,
          trackedModified: false,
          untracked: false,
        },
      },
      "commit changed",
    ],
    [
      "Source unavailable",
      { kind: "unsupported", path, reason: "path-encoding" },
      "cannot be represented as UTF-8",
    ],
  ];
  it.each(nonTextChanges)(
    "explains %s without showing a diff",
    (title, result, hint) => {
      render(<Detail state={ready(result)} />);
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.getByText(hint, { exact: false })).toBeInTheDocument();
    },
  );

  it("distinguishes a truncated diff from omitted context", () => {
    const renderDiff = (patch: GitDiffResponse) => (
      <Detail state={ready(patch)} />
    );
    const { rerender } = render(renderDiff({ ...diff, contextLimited: true }));
    const source = within(
      screen.getByRole("region", { name: "Source changes for notes.md" }),
    );
    expect(source.getByRole("status")).toHaveTextContent(
      "source context limited",
    );
    rerender(renderDiff({ ...diff, contextLimited: true, truncated: true }));
    expect(source.getByRole("status")).toHaveTextContent("Source truncated");
    expect(
      screen.getByRole("region", { name: "Source changes for notes.md" }),
    ).toHaveTextContent("New heading");
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
    const other = ready({ ...diff, path: otherPath });
    view.rerender(<Detail state={{ ...other, gitDiff: state.gitDiff }} />);
    expect(screen.queryByRole("region", { name: /Source changes/ })).toBeNull();
    view.rerender(<Detail state={other} readingState={readings()} />);
    callbacks.forEach((callback) => callback());
    expect(scroll).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Change position")).toHaveTextContent("1/2");
  });
});

describe("Git evidence boundaries", () => {
  it("retains a confirmed empty comparison through refresh only for the same owner", () => {
    const state = { ...ready(), gitStatus: clean, gitDiff: null };
    const pending = { ...state, gitStatusRefreshing: true };
    const view = render(<Detail state={pending} />);
    expect(screen.getByText("Reading Git status")).toBeVisible();

    view.rerender(<Detail state={state} />);
    view.rerender(<Detail state={pending} />);
    expect(screen.getByText("No Git comparison")).toBeVisible();
    for (const nextOwner of [
      {
        fileInspection: {
          kind: "file" as const,
          reference: "other.md",
          preview: null,
        },
      },
      { sessionId: "other-session" },
      { cwd: "/other" },
      { transportGeneration: state.transportGeneration + 1 },
    ]) {
      view.rerender(<Detail state={{ ...pending, ...nextOwner }} />);
      expect(screen.getByText("Reading Git status")).toBeVisible();
    }
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
          }}
        />,
      );
      expect(screen.getByRole("group", { name: label })).toBeVisible();
      expect(
        screen.queryByRole("region", { name: /Source changes/ }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Next change" }),
      ).toBeDisabled();
    },
  );
});
