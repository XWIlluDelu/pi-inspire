// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitDiffResponse,
  GitStatusResponse,
} from "../../shared/contracts";
import { createInitialAppState } from "../../src/app-state";
import type { ContextPaneView } from "../../src/components/context-pane-view";
import { selectContextPaneView } from "../../src/components/context-pane-view";
import { FilePreview } from "../../src/components/FilePreview";
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

describe("File Changes publication", () => {
  it("does not let a queued hunk jump target a newly selected file", () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callbacks.push(callback);
      return 0;
    });
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const state = ready();
    const view = render(
      <FilePreview state={state} readingState={readings()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    const otherPath = {
      id: "other",
      display: "other.md",
      utf8Path: "other.md",
    };
    const other = ready({ ...diff, path: otherPath });
    view.rerender(<FilePreview state={{ ...other, gitDiff: state.gitDiff }} />);
    expect(screen.queryByRole("region", { name: /Source changes/ })).toBeNull();
    view.rerender(<FilePreview state={other} readingState={readings()} />);
    callbacks.forEach((callback) => callback());
    expect(scroll).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Change position")).toHaveTextContent("1/2");
  });

  it("retains a confirmed empty comparison through refresh only for the same owner", () => {
    const state = { ...ready(), gitStatus: clean, gitDiff: null };
    const pending = { ...state, gitStatusPending: true };
    const view = render(<FilePreview state={pending} />);
    expect(screen.getByText("Reading Git status")).toBeVisible();

    view.rerender(<FilePreview state={state} />);
    view.rerender(<FilePreview state={pending} />);
    expect(screen.getByText("No Git comparison")).toBeVisible();
    for (const nextOwner of [
      {
        fileInspection: {
          kind: "file" as const,
          reference: "other.md",
          preview: null,
        },
        resourceTabs: [{ reference: "other.md", view: "changes" as const }],
      },
      { sessionId: "other-session" },
      { cwd: "/other" },
      { transportGeneration: state.transportGeneration + 1 },
    ]) {
      view.rerender(<FilePreview state={{ ...pending, ...nextOwner }} />);
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
        <FilePreview
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
