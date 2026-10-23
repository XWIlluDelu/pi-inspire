// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StatusControlDeclaration } from "../../shared/tool-presentation-config";
import { Welcome } from "../../src/components/Welcome";
import { sessionDraft, setStartDraft } from "../../src/session-drafts";
import { store } from "../../src/store";
import { mockModelMenuLayout } from "./fixtures/model-menu-layout";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
} from "./helpers";

const control: StatusControlDeclaration = {
  id: "user.example.mode",
  slot: "thinking",
  label: "Response mode",
  command: "/response-mode",
  state: { key: "mode", value: "mode" },
  options: [
    { value: "normal", label: "Normal" },
    { value: "quick", label: "Quick", indicator: "bolt" },
  ],
};
const commands = [
  {
    name: "response-mode",
    source: "extension",
    description: "Choose response mode",
  },
  { name: "review", source: "prompt", description: "Review the project" },
  {
    name: "skill:analyze",
    source: "skill",
    description: "Analyze the project",
  },
];
const model = {
  provider: "test",
  id: "test",
  name: "Test model",
  reasoning: false,
};
let available = true;
let rejectCommand = false;
let requests: string[];
let created: number;
function snapshot(mode = "normal", sessionId = "new-session") {
  return {
    ...activeSnapshot({ sessionId, cwd: "/target", model, commands }),
    extensionStatuses: { mode: JSON.stringify({ mode }) },
  };
}

beforeEach(async () => {
  available = true;
  rejectCommand = false;
  requests = [];
  created = 0;
  setStartDraft("");
  for (const notice of store.getState().notices) store.dismissNotice(notice.id);
  installFakeWebSocket();
  mockModelMenuLayout();
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          toolPresentations: {
            version: 1,
            rules: {},
            mappings: {},
            controls: [control],
          },
        }),
      };
    if (url.startsWith("/api/models"))
      return {
        body: {
          models: [model],
          commands: available ? commands : [],
          defaults: { cwd: "/target", model, thinkingLevel: "off" },
        },
      };
    if (url.startsWith("/api/sessions/new")) {
      created++;
      return { body: snapshot() };
    }
    if (url.startsWith("/api/prompt")) {
      const message = String(jsonBody(init).message);
      requests.push(message);
      if (rejectCommand && message.startsWith("/"))
        return { status: 400, body: { error: "Mode unavailable" } };
      return { status: 202, body: { accepted: true } };
    }
    if (url.startsWith("/api/sessions/refresh")) return { body: { ok: true } };
    if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
    if (url.startsWith("/api/preferences"))
      return { body: bootstrapPayload().preferences };
    return undefined;
  });
  await store.init("token");
  FakeWebSocket.instances.at(-1)!.open();
});
afterEach(() => {
  setStartDraft("");
  vi.restoreAllMocks();
});

async function selectMode() {
  render(<Welcome />);
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/target" },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Thinking level" }),
  );
  expect(screen.getByText("Thinking unavailable")).toBeVisible();
  expect(screen.getByRole("slider", { name: "Response mode" })).toBeEnabled();
  fireEvent.click(screen.getByText("Quick"));
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Quick");
  expect(created).toBe(0);
  expect(requests).toEqual([]);
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "Review this project" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() => expect(requests).toEqual(["/response-mode quick"]));
}

it("discovers target commands without a session and confirms a preselection before first input", async () => {
  await selectMode();
  expect(sessionDraft("new-session")).toBe("Review this project");
  // A dispatch receipt alone must not release the first message.
  await act(async () => {});
  expect(requests).toHaveLength(1);
  act(() =>
    FakeWebSocket.instances
      .at(-1)!
      .emit({ type: "snapshot", data: snapshot("quick") }),
  );
  await waitFor(() =>
    expect(requests).toEqual(["/response-mode quick", "Review this project"]),
  );
  expect(created).toBe(1);
});

it("uses discovered prompts and skills without reviving a removed inherited command", async () => {
  render(<Welcome />);
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/target" },
  });
  await screen.findByRole("button", { name: "Thinking level" });
  const input = screen.getByRole("textbox", { name: "First message" });
  fireEvent.change(input, { target: { value: "/review" } });
  expect(
    await screen.findByRole("option", { name: /Review the project/ }),
  ).toBeVisible();
  fireEvent.change(input, { target: { value: "/skill:analyze" } });
  expect(
    await screen.findByRole("option", { name: /Analyze the project/ }),
  ).toBeVisible();
  act(() =>
    FakeWebSocket.instances
      .at(-1)!
      .emit({
        type: "snapshot",
        data: activeSnapshot({
          sessionId: "source",
          cwd: "/target",
          model,
          commands: [
            {
              name: "retired",
              source: "prompt",
              description: "Retired prompt",
            },
          ],
        }),
      }),
  );
  fireEvent.change(input, { target: { value: "/retired" } });
  expect(screen.queryByRole("option", { name: /Retired prompt/ })).toBeNull();
  expect(created).toBe(0);
});

it("preserves the new session's draft if the selected control cannot apply", async () => {
  rejectCommand = true;
  await selectMode();
  await waitFor(() =>
    expect(
      store
        .getState()
        .notices.some((notice) =>
          notice.text.includes("Your first message is still in the composer"),
        ),
    ).toBe(true),
  );
  expect(sessionDraft("new-session")).toBe("Review this project");
  expect(requests).toEqual(["/response-mode quick"]);
});

it("retires a pending initialization when another session takes ownership", async () => {
  await selectMode();
  act(() =>
    FakeWebSocket.instances
      .at(-1)!
      .emit({ type: "snapshot", data: snapshot("normal", "other") }),
  );
  await act(async () => {});
  expect(requests).toEqual(["/response-mode quick"]);
  expect(sessionDraft("new-session")).toBe("Review this project");
  expect(
    store
      .getState()
      .notices.some((notice) => notice.text.includes("first message")),
  ).toBe(false);
});

it("drops capabilities from the old directory for both controls and command completion", async () => {
  render(<Welcome />);
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/target" },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Thinking level" }),
  );
  expect(screen.getByRole("slider", { name: "Response mode" })).toBeEnabled();
  available = false;
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/other" },
  });
  expect(screen.queryByRole("slider")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "/response" },
  });
  expect(screen.queryByRole("option", { name: /response-mode/ })).toBeNull();
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toBeDisabled(),
  );
  expect(created).toBe(0);
});
