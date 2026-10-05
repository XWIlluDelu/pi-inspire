// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GitStatusResponse } from "../../shared/contracts";
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
