// @vitest-environment jsdom
import { appendFile, readFile } from "node:fs/promises";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, Fragment } from "react";
import { expect, it, vi } from "vitest";
import type { ActiveSnapshot } from "../../shared/contracts";
import { createApi } from "../../src/api";
import { useTranscriptRows } from "../../src/components/transcript-row-projection";
import { type ChatMessage, messageText } from "../../src/events";
import type { CopyContent } from "../../src/content-copy";
import { messageCopyLoader } from "../../src/message-copy";
import { store } from "../../src/store";
import { transcriptProjectionKey } from "../../src/transcript-projection-key";
import { nativeSessionWorkbench } from "../server/fixtures/native-session-workbench";

it("copies complete saved messages through real Host pages without copying History activity or expanding previews", async () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  const originalFetch = globalThis.fetch;
  const originalState = store.getState();
  const internals = store as unknown as {
    api: ReturnType<typeof createApi> | null;
    set(patch: unknown): void;
  };
  const originalApi = internals.api;
  try {
    const host = await nativeSessionWorkbench(cleanup, { openSource: false });
    const entries = (await readFile(host.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const assistant = {
      role: "assistant",
      api: "openai-completions",
      provider: "export-fixture",
      model: "offline",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const userText = "User source. ".repeat(6000) + "USER_COPY_TAIL";
    const responseText =
      "Assistant source. ".repeat(4500) + "ASSISTANT_COPY_TAIL";
    const customText = "Custom source. ".repeat(6000) + "CUSTOM_COPY_TAIL";
    const detailText = "Custom details. ".repeat(4500) + "DETAIL_COPY_TAIL";
    const timestamp = new Date().toISOString();
    await appendFile(
      host.path,
      [
        {
          type: "message",
          id: "copyuser",
          parentId: entries.at(-1).id,
          timestamp,
          message: { role: "user", content: userText, timestamp: Date.now() },
        },
        {
          type: "message",
          id: "copyasst",
          parentId: "copyuser",
          timestamp,
          message: {
            ...assistant,
            content: [
              { type: "thinking", thinking: "THINKING_NOT_RESPONSE_COPY" },
              { type: "text", text: responseText },
              {
                type: "toolCall",
                id: "copytool",
                name: "read",
                arguments: { path: "TOOL_NOT_RESPONSE_COPY" },
              },
              { type: "text", text: "Final response fragment." },
            ],
          },
        },
        {
          type: "custom_message",
          id: "copycust",
          parentId: "copyasst",
          timestamp,
          customType: "copy_fixture",
          content: customText,
          details: { note: detailText },
          display: true,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    await host.runtime.openSession(host.id);
    await vi.waitFor(() => expect(host.workers[0]?.available).toBe(true), {
      timeout: 10000,
    });
    const requests: string[] = [];
    // Only transport addressing/authentication is adapted. Every response body,
    // including the bounded preview, comes from the real HTTP Host.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), host.url);
      requests.push(url.pathname + url.search);
      const headers = new Headers(init?.headers);
      headers.set("Authorization", host.headers.Authorization);
      return originalFetch(url, { ...init, headers });
    });
    const api = createApi();
    const snapshot: ActiveSnapshot = await api.snapshot(host.id);
    const page = snapshot.active!.transcriptPage;
    const messages = page.messages.filter((value: unknown) =>
      ["copyuser", "copyasst", "copycust"].includes(
        (value as ChatMessage).__inspireEntryId ?? "",
      ),
    ) as ChatMessage[];
    expect(messages).toHaveLength(3);
    expect(JSON.stringify(messages)).not.toContain("USER_COPY_TAIL");
    expect(JSON.stringify(messages)).not.toContain("ASSISTANT_COPY_TAIL");
    expect(JSON.stringify(messages)).not.toContain("CUSTOM_COPY_TAIL");
    expect(JSON.stringify(messages)).not.toContain("DETAIL_COPY_TAIL");
    internals.api = api;
    act(() =>
      internals.set({
        sessionId: host.id,
        transcriptViewId: page.viewId,
        transcriptIncarnation: page.incarnation,
      }),
    );
    const writeText = vi.fn(async (_value: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal("ClipboardItem", undefined);
    function Rows() {
      const rows = useTranscriptRows({
        messages,
        activityRanges: [],
        sessionId: host.id,
        viewId: page.viewId,
        projectionViewKey: transcriptProjectionKey(
          page.viewId,
          page.incarnation ?? null,
        ),
        streaming: false,
        runState: "idle",
        activeAssistantMessageKey: null,
        toolActivity: {},
        thinkingVisibility: "hidden",
        toolVisibility: "hidden",
        activityFoldVisibility: "expanded",
        onMaterializeActivityRanges: async () => {},
        preserveActivityAnchorRef: { current: () => {} },
      });
      return createElement(
        Fragment,
        null,
        ...rows.map((row) => createElement("div", { key: row.key }, row.node)),
      );
    }
    const view = render(createElement(Rows));
    const copy = async (name: RegExp, expected: string) => {
      fireEvent.click(screen.getByRole("button", { name }));
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expected));
    };
    await copy(/^Copy message$/i, userText);
    await copy(
      /^Copy response$/i,
      responseText + "\n\nFinal response fragment.",
    );
    await copy(
      /^Copy copy fixture block$/i,
      [
        "Copy fixture",
        "Type: copy_fixture",
        "Content",
        customText,
        "Details",
        JSON.stringify({ note: detailText }, null, 2),
      ].join("\n\n"),
    );
    for (const id of ["copyuser", "copyasst", "copycust"]) {
      expect(
        requests.some((path) => {
          const url = new URL(path, host.url);
          return (
            url.pathname === "/api/branches/entry" &&
            url.searchParams.get("format") === "message" &&
            url.searchParams.get("targetId") === id &&
            Number(url.searchParams.get("offset")) > 0
          );
        }),
      ).toBe(true);
    }
    const savedImage = (page.messages as ChatMessage[]).find(
      (value) => value.__inspireEntryId === "00000003",
    )!;
    const imageCopy = (await messageCopyLoader(
      savedImage,
      messageText(savedImage),
      {
        sessionId: host.id,
        viewId: page.viewId,
        projectionKey: transcriptProjectionKey(
          page.viewId,
          page.incarnation ?? null,
        ),
      },
    )(new AbortController().signal)) as CopyContent;
    expect(imageCopy.text).toBe("Shared prompt");
    expect(imageCopy.images?.[0]?.type).toBe("image/png");
    expect(imageCopy.images?.[0]?.size).toBeGreaterThan(0);
    expect(view.container.textContent).not.toContain("USER_COPY_TAIL");
    expect(view.container.textContent).not.toContain("CUSTOM_COPY_TAIL");
    view.unmount();
  } finally {
    internals.api = originalApi;
    act(() => internals.set(originalState));
    vi.unstubAllGlobals();
    for (const dispose of cleanup.reverse()) await dispose();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
}, 30000);
