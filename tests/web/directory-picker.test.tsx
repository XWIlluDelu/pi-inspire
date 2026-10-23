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
  it("recovers the requested directory instead of falling home after a transient failure", async () => {
    vi.useFakeTimers();
    const browse = vi
      .mocked(store.browseHostDirs)
      .mockRejectedValueOnce(new ApiError(503, "Directory service unavailable"))
      .mockImplementation(async (path) => (path ? project : home));
    const onPick = vi.fn();
    render(
      <DirectoryPicker
        initial={project.path}
        onCancel={vi.fn()}
        onPick={onPick}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(browse).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("textbox", { name: "Project directory" }),
    ).toHaveValue(project.path);
    expect(confirm()).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(browse).toHaveBeenCalledTimes(2);
    expect(browse).toHaveBeenLastCalledWith(project.path, false);
    expect(confirm()).toBeEnabled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("retains a confirmed listing through temporary reload failure, but invalidates an access denial", async () => {
    vi.useFakeTimers();
    const browse = vi.mocked(store.browseHostDirs).mockResolvedValue(home);
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
    fireEvent.change(input, { target: { value: ` ${home.path} ` } });
    fireEvent.click(confirm());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(browse).toHaveBeenCalledTimes(5);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("recovers advisory drive discovery without blocking directory selection", async () => {
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
    render(<DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(confirm()).toBeEnabled();
    expect(screen.queryByText(/Drive list unavailable/)).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(roots).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Z:" })).toBeEnabled();
  });

  it.each(["navigation", "visibility", "dismissal"] as const)(
    "retires a pending directory retry on %s",
    async (change) => {
      vi.useFakeTimers();
      vi.mocked(store.browseHostRoots).mockResolvedValue({
        roots: [
          { name: "/", path: "/" },
          { name: "Z:", path: "Z:\\" },
        ],
      });
      const browse = vi
        .mocked(store.browseHostDirs)
        .mockRejectedValueOnce(
          new ApiError(503, "Directory service unavailable"),
        )
        .mockResolvedValue(project);
      const view = render(
        <DirectoryPicker
          initial={home.path}
          onCancel={vi.fn()}
          onPick={vi.fn()}
        />,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      if (change === "navigation") {
        fireEvent.click(screen.getByRole("button", { name: "/" }));
      } else if (change === "visibility") {
        fireEvent.click(toggle());
      } else view.unmount();
      await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(browse).toHaveBeenCalledTimes(change === "dismissal" ? 1 : 2);
      if (change === "navigation")
        expect(browse).toHaveBeenLastCalledWith("/", false);
      if (change === "visibility")
        expect(browse).toHaveBeenLastCalledWith(home.path, true);
    },
  );
});

describe("independent drive discovery", () => {
  it("lets Home load and navigate before a delayed drive list arrives", async () => {
    const pending = deferred<{ roots: { name: string; path: string }[] }>();
    vi.mocked(store.browseHostRoots).mockReturnValue(pending.promise);
    vi.mocked(store.browseHostDirs).mockImplementation(async (path) =>
      path === project.path ? project : home,
    );
    render(<DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "project" }));
    await waitFor(() => expect(confirm()).toBeEnabled());
    await act(async () =>
      pending.resolve({
        roots: [
          { name: "C:", path: "C:\\" },
          { name: "Z:", path: "Z:\\" },
        ],
      }),
    );
    expect(
      screen.getByRole("textbox", { name: "Project directory" }),
    ).toHaveValue(project.path);
    expect(screen.getByRole("button", { name: "Z:" })).toBeEnabled();
  });

  it("keeps listing and typed selection usable when drive discovery fails", async () => {
    vi.mocked(store.browseHostRoots).mockRejectedValue(
      new ApiError(403, "Native probe unavailable"),
    );
    const onPick = vi.fn();
    render(<DirectoryPicker onCancel={vi.fn()} onPick={onPick} />);
    await waitFor(() => expect(confirm()).toBeEnabled());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Drive list unavailable",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(confirm());
    expect(onPick).toHaveBeenCalledWith(home.path);
  });

  it("ignores a drive-discovery failure after the dialog unmounts", async () => {
    const pending = deferred<{ roots: { name: string; path: string }[] }>();
    vi.mocked(store.browseHostRoots).mockReturnValue(pending.promise);
    const { unmount } = render(
      <DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />,
    );
    await waitFor(() => expect(confirm()).toBeEnabled());
    unmount();
    await act(async () => pending.reject(new Error("late failure")));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("typed project directories", () => {
  it("browses a typed path with Enter, then selects the host-normalized directory", async () => {
    const onPick = vi.fn();
    const browse = vi
      .mocked(store.browseHostDirs)
      .mockImplementation(async (path) =>
        path?.includes("project") ? project : home,
      );
    render(<DirectoryPicker onCancel={vi.fn()} onPick={onPick} />);
    await waitFor(() => expect(confirm()).toBeEnabled());
    const input = screen.getByRole("textbox", { name: "Project directory" });
    expect(input).toHaveValue(home.path);
    fireEvent.change(input, { target: { value: "  /home/demo/project/  " } });
    input.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(input).toHaveValue(project.path));
    expect(browse).toHaveBeenLastCalledWith("/home/demo/project/", false);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(confirm());
    expect(onPick).toHaveBeenCalledWith(project.path);
  });

  it("validates typed confirmation instead of selecting the old directory and recovers from invalid paths", async () => {
    const onPick = vi.fn();
    vi.mocked(store.browseHostDirs).mockImplementation(async (path) => {
      if (path === "/missing") throw new ApiError(404, "Directory not found");
      return path === project.path ? project : home;
    });
    render(<DirectoryPicker onCancel={vi.fn()} onPick={onPick} />);
    await waitFor(() => expect(confirm()).toBeEnabled());
    const input = screen.getByRole("textbox", { name: "Project directory" });
    fireEvent.change(input, { target: { value: "/missing" } });
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Directory not found",
    );
    expect(onPick).not.toHaveBeenCalled();
    expect(confirm()).toBeDisabled();
    fireEvent.change(input, { target: { value: project.path } });
    fireEvent.click(confirm());
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(project.path));
  });

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
  it.each([
    { root: "/home/demo", child: "/home/demo/.hidden", parent: "/home" },
    {
      root: "C:\\Users\\demo",
      child: "C:\\Users\\demo\\.hidden",
      parent: "C:\\Users",
    },
    {
      root: "\\\\server\\share",
      child: "\\\\server\\share\\.hidden",
      parent: null,
    },
  ])(
    "reveals and picks hidden folders using verbatim host paths: $root",
    async ({ root, child, parent }) => {
      const onPick = vi.fn();
      const browse = vi
        .mocked(store.browseHostDirs)
        .mockImplementation(async (path, hidden) => {
          if (path === child) return { path, parent: root, dirs: [] };
          return {
            path: root,
            parent,
            dirs: hidden ? [{ name: ".hidden", path: child }] : [],
          };
        });
      render(
        <DirectoryPicker initial={root} onCancel={vi.fn()} onPick={onPick} />,
      );
      await screen.findByText("No subdirectories");
      expect(toggle()).toHaveAttribute("aria-pressed", "false");
      expect(toggle().parentElement).toContainElement(
        screen.getByRole("heading", { name: "Choose project directory" }),
      );
      expect(toggle()).toHaveAttribute("title", "Show hidden folders");
      expect(
        screen.queryByRole("button", { name: ".hidden" }),
      ).not.toBeInTheDocument();
      fireEvent.click(toggle());
      fireEvent.click(await screen.findByRole("button", { name: ".hidden" }));
      await waitFor(() => expect(confirm()).toBeEnabled());
      expect(toggle()).toHaveAttribute("aria-pressed", "true");
      expect(toggle()).toHaveAttribute("title", "Hide hidden folders");
      expect(browse).toHaveBeenLastCalledWith(child, true);
      fireEvent.click(confirm());
      expect(onPick).toHaveBeenCalledWith(child);
    },
  );

  it("keeps the toggle across Windows drive navigation and resets on a new opening", async () => {
    vi.mocked(store.browseHostRoots).mockResolvedValue({
      roots: [
        { name: "C:", path: "C:\\" },
        { name: "D:", path: "D:\\" },
      ],
    });
    const browse = vi
      .mocked(store.browseHostDirs)
      .mockImplementation(async (path, hidden) => ({
        path: path ?? "C:\\",
        parent: null,
        dirs: hidden
          ? [{ name: "Hidden by OS", path: `${path ?? "C:\\"}Hidden by OS` }]
          : [],
      }));
    const { unmount } = render(
      <DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />,
    );
    await screen.findByText("No subdirectories");
    fireEvent.click(toggle());
    await screen.findByRole("button", { name: "Hidden by OS" });
    fireEvent.click(screen.getByRole("button", { name: "D:" }));
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith("D:\\", true));
    await waitFor(() => expect(confirm()).toBeEnabled());
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle());
    await screen.findByText("No subdirectories");
    expect(browse).toHaveBeenLastCalledWith("D:\\", false);
    fireEvent.click(toggle());
    await screen.findByRole("button", { name: "Hidden by OS" });
    unmount();
    render(<DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />);
    await screen.findByText("No subdirectories");
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
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
    await act(async () => oldNavigation.resolve(project));
    expect(screen.getByRole("button", { name: ".nested" })).toBeInTheDocument();
    expect(confirm()).toBeEnabled();
  });

  it("keeps the latest visibility after rapid toggles and ignores an old failure", async () => {
    const older = deferred<HostDirListing>();
    vi.mocked(store.browseHostDirs).mockImplementation(async (_path, hidden) =>
      hidden ? older.promise : home,
    );
    render(<DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />);
    await screen.findByRole("button", { name: "project" });
    fireEvent.click(toggle());
    expect(confirm()).toBeDisabled();
    fireEvent.click(toggle());
    await waitFor(() => expect(confirm()).toBeEnabled());
    await act(async () => older.reject(new Error("stale error")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.queryByRole("button", { name: ".hidden" }),
    ).not.toBeInTheDocument();
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

  it("shows errors, blocks stale confirmation, and allows recovery by changing visibility", async () => {
    const browse = vi
      .mocked(store.browseHostDirs)
      .mockImplementation(async (path, hidden) => {
        if (path === home.path && hidden)
          throw new ApiError(403, "Cannot read that directory");
        return home;
      });
    render(<DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />);
    await screen.findByRole("button", { name: "project" });
    fireEvent.click(toggle());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot read that directory",
    );
    expect(confirm()).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "project" }),
    ).not.toBeInTheDocument();
    fireEvent.click(toggle());
    await waitFor(() => expect(confirm()).toBeEnabled());
    expect(browse).toHaveBeenLastCalledWith(home.path, false);
  });

  it("is keyboard-operable and dismisses only the picker", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<DirectoryPicker onCancel={onCancel} onPick={vi.fn()} />);
    await screen.findByRole("button", { name: "project" });
    toggle().focus();
    await user.keyboard(" ");
    await screen.findByRole("button", { name: ".hidden" });
    expect(toggle()).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(confirm()).toBeEnabled());
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.queryByRole("button", { name: ".hidden" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps keyboard navigation in the refreshed list without stealing moved focus", async () => {
    const user = userEvent.setup();
    const pending = deferred<HostDirListing>();
    vi.mocked(store.browseHostDirs).mockImplementation(async (path) =>
      path === project.path ? pending.promise : home,
    );
    render(<DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />);
    const entry = await screen.findByRole("button", { name: "project" });
    entry.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("button", { name: "project" }),
    ).not.toBeInTheDocument();
    await act(async () => pending.resolve(project));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: ".." })).toHaveFocus(),
    );
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: "project" });
    expect(screen.getByRole("button", { name: ".." })).toHaveFocus();

    const next = deferred<HostDirListing>();
    vi.mocked(store.browseHostDirs).mockReturnValue(next.promise);
    screen.getByRole("button", { name: "project" }).focus();
    await user.keyboard("{Enter}");
    toggle().focus();
    await act(async () => next.resolve(project));
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
    await act(async () => pending.reject(new Error("missing")));
    expect(browse).toHaveBeenCalledTimes(1);
  });
});
