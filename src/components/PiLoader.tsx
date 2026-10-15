import { type ComponentProps, type CSSProperties, useState } from "react";

const PI_LOADING_VARIANTS = [
  "rows",
  "columns",
  "trace",
  "breathe",
  "spread",
  "relay",
  "gather",
] as const;
type PiLoadingVariant = (typeof PI_LOADING_VARIANTS)[number];

function choosePiLoadingVariant(): PiLoadingVariant {
  return PI_LOADING_VARIANTS[
    Math.floor(Math.random() * PI_LOADING_VARIANTS.length)
  ]!;
}

const points = [
  { x: 3.1, y: 3.1, row: 0, col: 0, trace: 2, spread: 1 },
  { x: 8, y: 3.1, row: 0, col: 1, trace: 3, spread: 0 },
  { x: 12.9, y: 3.1, row: 0, col: 2, trace: 4, spread: 1 },
  { x: 3.1, y: 8, row: 1, col: 0, trace: 1, spread: 2 },
  { x: 12.9, y: 8, row: 1, col: 2, trace: 5, spread: 2 },
  { x: 3.1, y: 12.9, row: 2, col: 0, trace: 0, spread: 3 },
  { x: 12.9, y: 12.9, row: 2, col: 2, trace: 6, spread: 3 },
];

type Props = Omit<ComponentProps<"svg">, "children" | "width" | "height"> & {
  size?: number;
};

/** An indeterminate Π, not a percentage or a rotating refresh action. */
export function PiLoader({
  size = 14,
  className = "",
  onAnimationIteration,
  ...props
}: Props) {
  const [pattern, setPattern] = useState(choosePiLoadingVariant);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={`pi-loading ${className}`.trim()}
      data-variant={pattern}
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
      onAnimationIteration={(event) => {
        // Dots have staggered, bubbling iteration events. Only the invisible
        // outer clock ends a complete pattern; ordinary rerenders do not.
        if (
          event.target === event.currentTarget &&
          event.animationName === "pi-loading-cycle"
        ) {
          setPattern(choosePiLoadingVariant());
        }
        onAnimationIteration?.(event);
      }}
    >
      {points.map((point, index) => (
        <rect
          key={`${pattern}:${index}`}
          x={point.x - 0.9}
          y={point.y - 0.9}
          width="1.8"
          height="1.8"
          rx="0.55"
          className="pi-loading__dot"
          style={
            {
              animationName:
                pattern === "rows" || pattern === "columns"
                  ? `pi-loading-step-${pattern === "rows" ? point.row : point.col}`
                  : undefined,
              animationDelay:
                pattern === "trace"
                  ? `${-2.4 + point.trace * (2.4 / 7)}s`
                  : pattern === "spread"
                    ? `${-2.4 + point.spread * 0.22}s`
                    : pattern === "relay"
                      ? `${point.col * -0.6}s`
                      : undefined,
              "--pi-gather-x": `${(8 - point.x) * 0.16}px`,
              "--pi-gather-y": `${(8 - point.y) * 0.16}px`,
            } as CSSProperties
          }
        />
      ))}
    </svg>
  );
}
