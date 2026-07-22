// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { store } from "../../src/store";
import { activeSnapshot, bootstrapPayload, installFakeWebSocket } from "./helpers";

describe("Files pane", () => {
  beforeEach(async () => {
    installFakeWebSocket();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/bootstrap")) {
        const messages = [{
          role: "assistant",
          content: [{ type: "text", text: "Open [notes](notes.md), [page](demo.html), or [Pi](https://pi.dev)." }],
          timestamp: 1,
        }];
        return Response.json(bootstrapPayload({ snapshot: activeSnapshot({ messages }) }));
      }
      if (url.startsWith("/api/sessions")) return Response.json({ sessions: [], total: 0, offset: 0, limit: 40 });
      if (url.startsWith("/api/resources/resolve")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { reference: string };
        const html = body.reference.endsWith(".html");
        return Response.json({
          id: html ? "html" : "markdown",
          sessionId: "s1",
          reference: body.reference,
          name: body.reference,
          mimeType: html ? "text/html" : "text/markdown",
          size: 64,
          kind: html ? "html" : "markdown",
        });
      }
      if (url.includes("/api/resources/markdown/content")) return new Response("# Previewed notes");
      if (url.includes("/api/resources/html/content")) {
        return new Response('<html><head><base href="https://bad.invalid"><meta http-equiv="refresh" content="0;url=https://bad.invalid"></head><body><script>bad()</script><h1>Safe page</h1></body></html>');
      }
      return Response.json({ error: `unhandled ${url}` }, { status: 404 });
    }));
    await store.init("token");
  });

  it("opens conversation file references and isolates HTML without restoring session metadata", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));

    expect(await screen.findByRole("complementary", { name: "Files and resources" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Previewed notes" })).toBeInTheDocument();
    expect(screen.queryByText("Session ID")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pi" })).toHaveAttribute("target", "_blank");

    fireEvent.click(screen.getByRole("link", { name: "page" }));
    expect(await screen.findByText("Open in sandboxed view")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open in sandboxed view" }));
    const frame = await screen.findByTitle("Sandboxed preview of demo.html");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(URL.createObjectURL).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close resources panel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Files and resources" })).not.toBeInTheDocument());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
});
