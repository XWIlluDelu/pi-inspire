export interface ImagePoint {
  x: number;
  y: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageGeometry {
  image: ImageSize;
  viewport: ImageSize;
}

export interface ImageView extends ImagePoint {
  /** CSS pixels per source pixel, independent of the device pixel ratio. */
  scale: number;
  fitted: boolean;
}

export const MAX_IMAGE_SCALE = 8;

export function imageFitScale({ image, viewport }: ImageGeometry): number {
  return Math.min(
    1,
    viewport.width / image.width,
    viewport.height / image.height,
  );
}

export function fitImage(geometry: ImageGeometry): ImageView {
  return { scale: imageFitScale(geometry), x: 0, y: 0, fitted: true };
}

export function constrainImage(
  view: ImageView,
  geometry: ImageGeometry,
): ImageView {
  const scale = Math.max(
    Math.min(0.1, imageFitScale(geometry)),
    Math.min(MAX_IMAGE_SCALE, view.scale),
  );
  const maxX = Math.max(
    0,
    (geometry.image.width * scale - geometry.viewport.width) / 2,
  );
  const maxY = Math.max(
    0,
    (geometry.image.height * scale - geometry.viewport.height) / 2,
  );
  return {
    ...view,
    scale,
    x: Math.max(-maxX, Math.min(maxX, view.x)),
    y: Math.max(-maxY, Math.min(maxY, view.y)),
  };
}

/** Anchors are CSS-pixel offsets from the viewport center. A pinch can move
 * its center as well as change scale; clamp only after both transformations. */
export function zoomImage(
  view: ImageView,
  geometry: ImageGeometry,
  scale: number,
  anchor: ImagePoint = { x: 0, y: 0 },
  destination = anchor,
): ImageView {
  const bounded = constrainImage({ ...view, scale }, geometry).scale;
  const ratio = bounded / view.scale;
  return constrainImage(
    {
      scale: bounded,
      x: destination.x - (anchor.x - view.x) * ratio,
      y: destination.y - (anchor.y - view.y) * ratio,
      fitted: false,
    },
    geometry,
  );
}

/** Fit follows the viewport; a manually positioned view preserves its source
 * pixel scale and center, then clamps to the newly available space. */
export function resizeImage(
  view: ImageView,
  geometry: ImageGeometry,
): ImageView {
  return view.fitted ? fitImage(geometry) : constrainImage(view, geometry);
}
