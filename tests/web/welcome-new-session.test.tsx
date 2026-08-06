// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { Welcome } from "../../src/components/Welcome";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
} from "./helpers";

let newSessionBody: Record<string, unknown> | null;
let promptBody: Record<string, unknown> | null;

beforeAll(async () => {
  newSessionBody = null;
  promptBody = null;
  installFakeWebSocket();
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload({
      availableModels: [
        { provider: "plain", id: "text-only", name: "Text only", reasoning: false },
        { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true },
      ],
    }) };
    if (url.startsWith("/api/sessions/new")) {
      newSessionBody = jsonBody(init);
      return { body: activeSnapshot({
        sessionId: "new-session",
        model: { provider: "anthropic", id: "claude-sonnet-4", reasoning: true },
        thinkingLevel: "high",
        availableModels: [
          { provider: "plain", id: "text-only", name: "Text only", reasoning: false },
          { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true },
        ],
      }) };
    }
    if (url.startsWith("/api/prompt")) {
      promptBody = jsonBody(init);
      return { status: 202, body: { accepted: true } };
    }
    if (url.startsWith("/api/sessions/refresh")) return { body: { ok: true } };
    if (url.startsWith("/api/sessions")) return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
    if (url.startsWith("/api/preferences")) return { body: { ...bootstrapPayload().preferences, ...jsonBody(init) } };
    return undefined;
  });
  await store.init("token");
  FakeWebSocket.instances.at(-1)?.open();
});

describe("new-session start surface", () => {
  it("expands with the first message and sends explicit model/effort startup choices", async () => {
    render(<Welcome />);
    const message = screen.getByLabelText("First message") as HTMLTextAreaElement;
    Object.defineProperty(message, "scrollHeight", { configurable: true, value: 180 });
    fireEvent.change(message, { target: { value: "Investigate the runtime" } });
    await waitFor(() => expect(message.style.height).toBe("180px"));

    fireEvent.click(screen.getByRole("combobox", { name: "New session model" }));
    let models = screen.getByRole("listbox", { name: "New session model" });
    fireEvent.click(within(models).getByRole("option", { name: "Text only · plain" }));
    expect(screen.getByRole("combobox", { name: "New session effort" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "New session effort" })).toHaveTextContent("Not supported");

    fireEvent.click(screen.getByRole("combobox", { name: "New session model" }));
    models = screen.getByRole("listbox", { name: "New session model" });
    fireEvent.click(within(models).getByRole("option", { name: "Claude Sonnet 4 · anthropic" }));
    fireEvent.click(screen.getByRole("combobox", { name: "New session effort" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "New session effort" })).getByRole("option", { name: "high" }));

    fireEvent.change(screen.getByLabelText("Project directory"), { target: { value: "/proj" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(newSessionBody).toEqual({
      cwd: "/proj",
      model: { provider: "anthropic", id: "claude-sonnet-4" },
      thinkingLevel: "high",
    }));
    await waitFor(() => expect(promptBody).toMatchObject({
      sessionId: "new-session",
      message: "Investigate the runtime",
    }));
  });
});
