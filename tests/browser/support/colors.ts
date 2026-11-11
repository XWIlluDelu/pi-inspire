import type { Locator } from "@playwright/test";

/** Resolve modern CSS colors and composite translucent backgrounds as rendered. */
function measureColors(target: Element | Element[]) {
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
  const luminance = (color: number[]) =>
    color.slice(0, 3).reduce((total, channel, i) => {
      const value = channel / 255;
      return (
        total +
        [0.2126, 0.7152, 0.0722][i]! *
          (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      );
    }, 0);
  return (Array.isArray(target) ? target : [target]).map((element) => {
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
    const fg = luminance(foreground),
      bg = luminance(background);
    return {
      foreground,
      background,
      contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
    };
  });
}

export async function renderedColors(locator: Locator) {
  return (await locator.evaluate(measureColors))[0]!;
}

export function renderedColorSamples(locator: Locator) {
  return locator.evaluateAll(measureColors);
}

/** Resolve a role in the owning surface, including its local token overrides. */
export function resolvedColor(locator: Locator, role: string) {
  return locator.evaluate((element, role) => {
    const value = getComputedStyle(element).getPropertyValue(`--${role}`);
    const probe = document.createElement("span");
    probe.style.color = value;
    if (!probe.style.color) throw new Error(`Invalid color role: --${role}`);
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, role);
}
