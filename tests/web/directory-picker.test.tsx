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
import { DirectoryPicker } from "../../src/components/DirectoryPicker";
import { store } from "../../src/store";

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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.spyOn(store, "browseHostRoots").mockResolvedValue({
    roots: [{ name: "/", path: "/" }],
  });
  vi.spyOn(store, "browseHostDirs").mockImplementation(async (_path, hidden) =>
    hidden ? hiddenHome : home,
  );
});
afterEach(() => cleanup());

const toggle = () =>
  screen.getByRole("checkbox", { name: "Show hidden folders" });
const confirm = () =>
  screen.getByRole("button", { name: "Use this directory" });

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
      expect(toggle()).not.toBeChecked();
      expect(
        screen.queryByRole("button", { name: ".hidden" }),
      ).not.toBeInTheDocument();
      fireEvent.click(toggle());
      fireEvent.click(await screen.findByRole("button", { name: ".hidden" }));
      await waitFor(() => expect(confirm()).toBeEnabled());
      expect(toggle()).toBeChecked();
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
    expect(toggle()).toBeChecked();
    fireEvent.click(toggle());
    await screen.findByText("No subdirectories");
    expect(browse).toHaveBeenLastCalledWith("D:\\", false);
    fireEvent.click(toggle());
    await screen.findByRole("button", { name: "Hidden by OS" });
    unmount();
    render(<DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />);
    await screen.findByText("No subdirectories");
    expect(toggle()).not.toBeChecked();
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
    expect(toggle()).not.toBeChecked();
    expect(
      screen.queryByRole("button", { name: ".hidden" }),
    ).not.toBeInTheDocument();
  });

  it("preserves hidden visibility through initial home fallback", async () => {
    const oldFallback = deferred<HostDirListing>();
    const browse = vi
      .mocked(store.browseHostDirs)
      .mockImplementation(async (path, hidden) => {
        if (path === "relative") throw new Error("path must be absolute");
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
          throw new Error("Cannot read that directory");
        return home;
      });
    render(<DirectoryPicker onCancel={vi.fn()} onPick={vi.fn()} />);
    await screen.findByRole("button", { name: "project" });
    fireEvent.click(toggle());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot read that directory",
    );
    expect(confirm()).toBeDisabled();
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
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
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
