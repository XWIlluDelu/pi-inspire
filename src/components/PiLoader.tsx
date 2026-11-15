import type { ComponentProps } from "react";

const points = [
  [3.1, 3.1],
  [8, 3.1],
  [12.9, 3.1],
  [3.1, 8],
  [12.9, 8],
  [3.1, 12.9],
  [12.9, 12.9],
] as const;

type Props = Omit<ComponentProps<"svg">, "children" | "width" | "height"> & {
  size?: number;
};

export function PiLoader({ size = 14, className = "", ...props }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={`pi-loading ${className}`.trim()}
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    >
      {points.map(([x, y]) => (
        <rect
          key={`${x}:${y}`}
          x={x - 0.9}
          y={y - 0.9}
          width="1.8"
          height="1.8"
          rx="0.55"
        />
      ))}
    </svg>
  );
}
