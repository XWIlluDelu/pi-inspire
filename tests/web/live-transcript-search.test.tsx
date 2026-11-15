// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Transcript } from "../../src/components/Transcript";
import { openTranscriptSearch } from "./helpers";

describe("Live transcript search navigation", () => {
  it("clears view-local search when the branch projection changes", () => {
    const props = {
      sessionId: "branch-session",
      messages: [{ role: "assistant", content: "branch answer", timestamp: 1 }],
      streaming: false,
      thinkingVisibility: "collapsed" as const,
      toolVisibility: "collapsed" as const,
    };
    const { rerender } = render(<Transcript {...props} viewId="branch-a" />);
    const search = openTranscriptSearch();
    fireEvent.change(search, { target: { value: "answer" } });
    expect(search).toHaveValue("answer");

    rerender(<Transcript {...props} viewId="branch-b" />);
    expect(search).toHaveValue("");
  });
});
