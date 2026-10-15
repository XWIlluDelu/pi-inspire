import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ImageGallery } from "../../src/components/ImageGallery";
import { ImagePreview } from "../../src/components/ImagePreview";

afterEach(async () => {
  cleanup();
  // Let an owner-removal history traversal settle before mounting the next owner.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
});

describe("image source ownership", () => {
  it("fits the next figure even when it reuses the same document-owned URL", () => {
    render(
      <ImageGallery>
        <ImagePreview src="blob:shared" name="First figure" />
        <ImagePreview src="blob:shared" name="Repeated figure" />
      </ImageGallery>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Preview First figure" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Image preview" });
    const image = dialog.querySelector("img")!;
    Object.defineProperties(image, {
      naturalWidth: { value: 1200 },
      naturalHeight: { value: 800 },
    });
    fireEvent.load(image);
    const originalFit = image.style.transform;
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Actual size" }),
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Image background" }),
      { target: { value: "Black" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Next image" }));
    expect(dialog.querySelector("img")).toBe(image);
    expect(image.style.transform).toBe(originalFit);
    expect(
      within(dialog).getByRole("combobox", { name: "Image background" }),
    ).toHaveValue("Black");
    expect(
      within(dialog).getByRole("group", { name: "Image navigation" }),
    ).toHaveTextContent("2 / 2");
  });
  it("orders a gallery by the document, updates labels without closing, and never revives a retired selection", async () => {
    const items = (sources: string[], name = "two.png") => (
      <StrictMode>
        <ImageGallery>
          {sources.map((src) => (
            <ImagePreview
              key={src}
              src={src}
              name={src === "blob:two" ? name : "one.png"}
            />
          ))}
        </ImageGallery>
      </StrictMode>
    );
    const { rerender } = render(items(["blob:one", "blob:two"]));
    fireEvent.click(screen.getByRole("button", { name: "Preview two.png" }));
    let dialog = screen.getByRole("dialog", { name: "Image preview" });
    expect(
      within(dialog).getByRole("group", { name: "Image navigation" }),
    ).toHaveTextContent("2 / 2");
    rerender(items(["blob:two", "blob:one"], "renamed.png"));
    dialog = screen.getByRole("dialog", { name: "Image preview" });
    expect(within(dialog).getByText("renamed.png")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("group", { name: "Image navigation" }),
    ).toHaveTextContent("1 / 2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next image" }));
    expect(dialog.querySelector("img")).toHaveAttribute("src", "blob:one");
    rerender(items(["blob:two"]));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Image preview" }),
      ).toBeNull(),
    );
    rerender(items(["blob:one", "blob:two"]));
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
  });

  it("retires a single-image reader when its URL changes instead of reopening when an old URL returns", async () => {
    const { rerender } = render(
      <ImagePreview src="blob:first" name="file.png" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file.png" }));
    expect(
      screen.getByRole("dialog", { name: "Image preview" }),
    ).toBeInTheDocument();
    rerender(<ImagePreview src="blob:replacement" name="file.png" />);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Image preview" }),
      ).toBeNull(),
    );
    rerender(<ImagePreview src="blob:first" name="file.png" />);
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
  });
});
