// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GitStatusResponse } from "../../shared/contracts";
import { ChangesPane } from "../../src/components/ChangesPane";
import { store } from "../../src/store";

const repository: GitStatusResponse = {
  kind: "repository",
  head: { kind: "branch", name: "main", oid: "0".repeat(40) },
  files: [],
  total: 0,
  truncated: false,
  groups: { staged: [], unstaged: [], untracked: [], conflicted: [] },
};

describe("filesystem selection is not Git evidence", () => {
  it.each([
    [null, null, "Git status unavailable"],
    [repository, "failed", "Git status unavailable"],
    [{ kind: "not-repository" }, null, "Not in a Git repository"],
    [
      { ...repository, truncated: true, total: 1001 },
      null,
      "Git status incomplete",
    ],
    [repository, null, "No Git comparison"],
  ] as const)(
    "does not turn an absent status entry into zero changes (%s, %s)",
    (gitStatus, gitStatusError, label) => {
      render(
        <ChangesPane
          state={{
            ...store.getState(),
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
          ...store.getState(),
          gitStatus: {
            ...repository,
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
