import type { Locator } from "@playwright/test";

/** Resolve modern CSS colors and composite translucent backgrounds as rendered. */
export async function renderedColors(locator: Locator) {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (value: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, alpha! / 255];
    };
    const over = (front: number[], back: number[]): number[] => {
      const alpha = front[3]! + back[3]! * (1 - front[3]!);
      if (!alpha) return [0, 0, 0, 0];
      return [
        ...[0, 1, 2].map(
          (i) =>
            (front[i]! * front[3]! + back[i]! * back[3]! * (1 - front[3]!)) /
            alpha,
        ),
        alpha,
      ];
    };
    const layers: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement)
      layers.unshift(node);
    let background = [255, 255, 255, 1];
    for (const layer of layers)
      background = over(
        rgba(getComputedStyle(layer).backgroundColor),
        background,
      );
    const foreground = over(rgba(getComputedStyle(element).color), background);
    const luminance = (color: number[]) =>
      color.slice(0, 3).reduce((total, channel, i) => {
        const value = channel / 255;
        return (
          total +
          [0.2126, 0.7152, 0.0722][i]! *
            (value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4)
        );
      }, 0);
    const fg = luminance(foreground),
      bg = luminance(background);
    return {
      foreground,
      background,
      contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
    };
  });
}
