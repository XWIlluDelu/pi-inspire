import {
  createContext,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { useInspectionHistory } from "../use-inspection-history";
import { ImageLightbox, type PreviewImage } from "./ImageLightbox";

interface GalleryImage extends PreviewImage {
  id: string;
  element: HTMLElement;
}

type Selection = Pick<GalleryImage, "id" | "src">;

export const ImageGalleryContext = createContext<{
  register: (image: GalleryImage) => void;
  unregister: (id: string) => void;
  open: (image: Selection) => void;
} | null>(null);

/** A message, attachment tray, or document owns a gallery. Registration does
 * not fetch images or outlive their source owner; DOM order handles reordering. */
export function ImageGallery({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ReadonlyMap<string, GalleryImage>>(
    new Map(),
  );
  const [selection, setSelection] = useState<Selection | null>(null);
  const register = useCallback((image: GalleryImage) => {
    setEntries((previous) => new Map(previous).set(image.id, image));
  }, []);
  const unregister = useCallback((id: string) => {
    setEntries((previous) => {
      const next = new Map(previous);
      next.delete(id);
      return next;
    });
  }, []);
  const context = useMemo(
    () => ({ register, unregister, open: setSelection }),
    [register, unregister],
  );

  const active = selection ? entries.get(selection.id) : undefined;
  const open = Boolean(active && active.src === selection?.src);
  if (selection && !open) setSelection(null);
  const close = () => setSelection(null);
  useInspectionHistory(open ? 1 : 0, close, "__inspireImagePreview");
  const images = open
    ? [...entries.values()].sort((a, b) => {
        const order = a.element.compareDocumentPosition(b.element);
        return order & Node.DOCUMENT_POSITION_PRECEDING
          ? 1
          : order & Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 0;
      })
    : [];
  const index = images.findIndex((image) => image.id === selection?.id);

  return (
    <ImageGalleryContext.Provider value={context}>
      {children}
      {open && active ? (
        <ImageLightbox
          image={active}
          index={index}
          count={images.length}
          onNavigate={(next) => {
            const image = images[next];
            if (image) setSelection({ id: image.id, src: image.src });
          }}
          onClose={close}
        />
      ) : null}
    </ImageGalleryContext.Provider>
  );
}
