// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDirListing } from "../../shared/contracts";
import { ApiError } from "../../src/api";
import { DirectoryPicker } from "../../src/components/DirectoryPicker";
import { store } from "../../src/store";
import { deferred } from "./helpers";

const home: HostDirListing = {
  path: "/home/demo",
  parent: "/home",
  dirs: [{ name: "project", path: "/home/demo/project" }],
};
const hiddenHome: HostDirListing = {
  ...home,
  dirs: [...home.dirs, { name: ".hidden", path: "/home/demo/.hidden" }],
};
const project: HostDirListing = {
  path: "/home/demo/project",
  parent: home.path,
  dirs: [],
};

beforeEach(() => {
  vi.spyOn(store, "browseHostRoots").mockResolvedValue({
    roots: [{ name: "/", path: "/" }],
  });
  vi.spyOn(store, "browseHostDirs").mockImplementation(async (_path, hidden) =>
    hidden ? hiddenHome : home,
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const toggle = () =>
  screen.getByRole("button", { name: "Show hidden folders" });
const confirm = () =>
  screen.getByRole("button", { name: "Use this directory" });

describe("read recovery", () => {
  it("retries the requested directory, retaining accepted entries only through temporary failures", async () => {
    vi.useFakeTimers();
    const browse = vi
      .mocked(store.browseHostDirs)
      .mockRejectedValueOnce(new ApiError(503, "Directory service unavailable"))
      .mockResolvedValue(home);
    const onPick = vi.fn();
    render(
      <DirectoryPicker
        initial={home.path}
        onCancel={vi.fn()}
        onPick={onPick}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    const input = screen.getByRole("textbox", { name: "Project directory" });
    expect(input).toHaveValue(home.path);
    expect(confirm()).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(browse.mock.calls).toEqual([
      [home.path, false],
      [home.path, false],
    ]);
    expect(confirm()).toBeEnabled();

    browse.mockRejectedValueOnce(new ApiError(503, "Temporary read failure"));
    fireEvent.keyDown(input, { key: "Enter" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("button", { name: "project" })).toBeVisible();
    expect(confirm()).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(confirm()).toBeEnabled();
    browse.mockRejectedValue(new ApiError(403, "Access denied"));
    fireEvent.keyDown(input, { key: "Enter" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("alert")).toHaveTextContent("Access denied");
    expect(screen.queryByRole("button", { name: "project" })).toBeNull();
    const attempts = browse.mock.calls.length;
    fireEvent.change(input, { target: { value: ` ${home.path} ` } });
    fireEvent.click(confirm());
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(browse).toHaveBeenCalledTimes(attempts + 1);
    expect(browse).toHaveBeenLastCalledWith(home.path, false);
    expect(onPick).not.toHaveBeenCalled();
    browse.mockResolvedValue(home);
    fireEvent.click(toggle());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(confirm()).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lets directory navigation continue while advisory drive discovery retries", async () => {
    vi.useFakeTimers();
    const roots = vi
      .mocked(store.browseHostRoots)
      .mockRejectedValueOnce(new ApiError(503, "Drive service unavailable"))
      .mockResolvedValue({
        roots: [
          { name: "/", path: "/" },
          { name: "Z:", path: "Z:\\" },
        ],
      });
    vi.mocked(store.browseHostDirs).mockImplementation(async (path) =>
      path === project.path ? project : home,
    );
    render(<DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "project" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(confirm()).toBeEnabled();
    expect(screen.queryByText(/Drive list unavailable/)).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(roots).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Z:" })).toBeEnabled();
    expect(
      screen.getByRole("textbox", { name: "Project directory" }),
    ).toHaveValue(project.path);
  });

  it("retires scheduled directory reads after navigation, visibility changes, and dismissal", async () => {
    vi.useFakeTimers();
    vi.mocked(store.browseHostRoots).mockResolvedValue({
      roots: [
        { name: "/", path: "/" },
        { name: "Z:", path: "Z:\\" },
      ],
    });
    const browse = vi
      .mocked(store.browseHostDirs)
      .mockRejectedValueOnce(new ApiError(503, "Directory service unavailable"))
      .mockRejectedValueOnce(new ApiError(503, "Directory service unavailable"))
      .mockResolvedValue({ path: "/", parent: null, dirs: [] });
    const view = render(
      <DirectoryPicker
        initial={home.path}
        onCancel={vi.fn()}
        onPick={vi.fn()}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "/" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(toggle());
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(browse.mock.calls).toEqual([
      [home.path, false],
      ["/", false],
      ["/", true],
    ]);

    browse.mockRejectedValue(
      new ApiError(503, "Directory service unavailable"),
    );
    fireEvent.click(toggle());
    await act(() => vi.advanceTimersByTimeAsync(0));
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(browse).toHaveBeenCalledTimes(4);
  });
});

describe("typed project directories", () => {
  it("does not pick a pending typed confirmation after dismissal", async () => {
    const pending = deferred<HostDirListing>();
    const onPick = vi.fn();
    vi.mocked(store.browseHostDirs).mockImplementation((path) =>
      path === project.path ? pending.promise : Promise.resolve(home),
    );
    const { unmount } = render(
      <DirectoryPicker onCancel={vi.fn()} onPick={onPick} />,
    );
    await waitFor(() => expect(confirm()).toBeEnabled());
    const input = screen.getByRole("textbox", { name: "Project directory" });
    fireEvent.change(input, { target: { value: project.path } });
    fireEvent.click(confirm());
    expect(input).toHaveAttribute("readonly");
    unmount();
    await act(async () => pending.resolve(project));
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("hidden project directories", () => {
  it("refreshes hidden folders without discarding an unsubmitted address", async () => {
    const refresh = deferred<HostDirListing>();
    const browse = vi
      .mocked(store.browseHostDirs)
      .mockImplementation((path, hidden) =>
        path === project.path
          ? Promise.resolve(project)
          : hidden
            ? refresh.promise
            : Promise.resolve(home),
      );
    const onPick = vi.fn();
    render(<DirectoryPicker onCancel={vi.fn()} onPick={onPick} />);
    await screen.findByRole("button", { name: "project" });
    const input = screen.getByRole("textbox", { name: "Project directory" });
    const draft = ` ${project.path} `;
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.click(toggle());
    expect(browse).toHaveBeenLastCalledWith(home.path, true);
    expect(input).toHaveValue(draft);
    await act(async () => refresh.resolve(hiddenHome));
    expect(screen.getByRole("button", { name: ".hidden" })).toBeVisible();
    expect(input).toHaveValue(draft);
    fireEvent.click(confirm());
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(project.path));
    expect(browse).toHaveBeenLastCalledWith(project.path, true);
  });

  it("retains the destination when toggled during navigation and ignores the superseded response", async () => {
    const oldNavigation = deferred<HostDirListing>();
    const newNavigation = deferred<HostDirListing>();
    const browse = vi
      .mocked(store.browseHostDirs)
      .mockImplementation(async (path, hidden) => {
        if (path === project.path)
          return hidden ? newNavigation.promise : oldNavigation.promise;
        return home;
      });
    render(<DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "project" }));
    expect(confirm()).toBeDisabled();
    fireEvent.click(toggle());
    expect(browse).toHaveBeenLastCalledWith(project.path, true);
    await act(async () =>
      newNavigation.resolve({
        ...project,
        dirs: [{ name: ".nested", path: `${project.path}/.nested` }],
      }),
    );
    await screen.findByRole("button", { name: ".nested" });
    await act(async () =>
      oldNavigation.reject(new ApiError(403, "Stale denial")),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: ".nested" })).toBeInTheDocument();
    expect(confirm()).toBeEnabled();
  });

  it("preserves hidden visibility through initial home fallback", async () => {
    const oldFallback = deferred<HostDirListing>();
    const browse = vi
      .mocked(store.browseHostDirs)
      .mockImplementation(async (path, hidden) => {
        if (path === "relative")
          throw new ApiError(400, "path must be absolute");
        return hidden ? hiddenHome : oldFallback.promise;
      });
    render(
      <DirectoryPicker
        initial="relative"
        onCancel={vi.fn()}
        onPick={vi.fn()}
      />,
    );
    await waitFor(() => expect(browse).toHaveBeenCalledWith(undefined, false));
    fireEvent.click(toggle());
    await screen.findByRole("button", { name: ".hidden" });
    expect(browse).toHaveBeenLastCalledWith(undefined, true);
    await act(async () => oldFallback.resolve(home));
    expect(screen.getByRole("button", { name: ".hidden" })).toBeInTheDocument();
  });

  it("does not steal focus after a pending directory navigation", async () => {
    const user = userEvent.setup();
    const pending = deferred<HostDirListing>();
    vi.mocked(store.browseHostDirs).mockImplementation(async (path) =>
      path === project.path ? pending.promise : home,
    );
    render(<DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />);
    const entry = await screen.findByRole("button", { name: "project" });
    entry.focus();
    await user.keyboard("{Enter}");
    toggle().focus();
    await act(async () => pending.resolve(project));
    expect(screen.getByRole("button", { name: ".." })).toBeVisible();
    expect(toggle()).toHaveFocus();
  });

  it("does not start a late home fallback after dismissal", async () => {
    const pending = deferred<HostDirListing>();
    const browse = vi
      .mocked(store.browseHostDirs)
      .mockReturnValue(pending.promise);
    const { unmount } = render(
      <DirectoryPicker initial="missing" onCancel={vi.fn()} onPick={vi.fn()} />,
    );
    unmount();
    await act(async () => pending.reject(new ApiError(404, "missing")));
    expect(browse).toHaveBeenCalledTimes(1);
  });
});
