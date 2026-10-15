import { describe, expect, it } from "vitest";
import {
  constrainImage,
  fitImage,
  imageFitScale,
  resizeImage,
  zoomImage,
  type ImageGeometry,
} from "../../src/image-viewport";

describe("image inspection geometry", () => {
  it.each([
    { width: 3840, height: 2160 },
    { width: 1200, height: 8000 },
    { width: 6000, height: 600 },
    { width: 64, height: 64 },
  ])(
    "fits without upscaling, then reaches source size: $width × $height",
    (image) => {
      const geometry = { image, viewport: { width: 358, height: 680 } };
      const fit = fitImage(geometry);
      expect(fit.scale).toBeLessThanOrEqual(1);
      expect(image.width * fit.scale).toBeLessThanOrEqual(358);
      expect(image.height * fit.scale).toBeLessThanOrEqual(680);
      expect(zoomImage(fit, geometry, 1).scale).toBe(1);
      expect(zoomImage(fit, geometry, 8).scale).toBe(8);
    },
  );

  const geometry: ImageGeometry = {
    image: { width: 1200, height: 800 },
    viewport: { width: 600, height: 400 },
  };

  it("keeps a clicked source point under the pointer, including a moving pinch center", () => {
    const view = fitImage(geometry);
    const anchor = { x: -100, y: -50 };
    for (const destination of [anchor, { x: 40, y: 20 }]) {
      const zoomed = zoomImage(view, geometry, 1, anchor, destination);
      expect((destination.x - zoomed.x) / zoomed.scale).toBe(
        (anchor.x - view.x) / view.scale,
      );
      expect((destination.y - zoomed.y) / zoomed.scale).toBe(
        (anchor.y - view.y) / view.scale,
      );
    }
  });

  it("clamps pan after rotation and enlargement; a small image always stays centered", () => {
    const original = { scale: 1, fitted: false, x: 500, y: 3600 };
    const rotated = {
      image: { width: 1200, height: 8000 },
      viewport: { width: 812, height: 220 },
    };
    const next = resizeImage(original, rotated);
    expect(next).toEqual({ ...original, x: 194 });
    expect(
      resizeImage(next, {
        ...rotated,
        viewport: { width: 1800, height: 9000 },
      }),
    ).toEqual({ ...original, x: 0, y: 0 });
    const small = {
      image: { width: 64, height: 64 },
      viewport: { width: 358, height: 680 },
    };
    expect(constrainImage({ ...original, scale: 2 }, small)).toEqual({
      scale: 2,
      fitted: false,
      x: 0,
      y: 0,
    });
  });

  it("only the fit mode follows a changed viewport, keeping manual scale and reading position", () => {
    const changed = { ...geometry, viewport: { width: 320, height: 600 } };
    expect(resizeImage(fitImage(geometry), changed).scale).toBe(
      imageFitScale(changed),
    );
    const manual = { scale: 1, fitted: false, x: 50, y: 20 };
    expect(resizeImage(manual, changed)).toEqual(manual);
  });

  it("bounds extreme zoom before computing its anchored pan", () => {
    const fitted = fitImage(geometry);
    expect(zoomImage(fitted, geometry, 1e9).scale).toBe(8);
    expect(zoomImage(fitted, geometry, 0).scale).toBe(0.1);
    const long = {
      image: { width: 1200, height: 10000 },
      viewport: { width: 320, height: 400 },
    };
    expect(zoomImage(fitImage(long), long, 0).scale).toBe(0.04);
  });
});
