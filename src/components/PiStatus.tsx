import type { ComponentProps } from "react";

const marks = {
  success: {
    path: "M3.1 8 8 12.9 12.9 3.1",
    points: [
      [3.1, 8],
      [8, 12.9],
      [12.9, 3.1],
    ],
  },
  error: {
    path: "M3.1 3.1 12.9 12.9M12.9 3.1 3.1 12.9",
    points: [
      [3.1, 3.1],
      [12.9, 3.1],
      [8, 8],
      [3.1, 12.9],
      [12.9, 12.9],
    ],
  },
  neutral: {
    path: null,
    points: [
      [3.1, 3.1],
      [8, 3.1],
      [12.9, 3.1],
      [3.1, 8],
      [12.9, 8],
      [3.1, 12.9],
      [8, 12.9],
      [12.9, 12.9],
    ],
  },
} as const;

type Props = Omit<ComponentProps<"svg">, "children" | "width" | "height"> & {
  size?: number;
  status: keyof typeof marks;
};

/** Static 3×3 outcomes: linked check/cross, or an empty-centered neutral ring. */
export function PiStatus({
  size = 14,
  status,
  className = "",
  ...props
}: Props) {
  const mark = marks[status];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={`pi-status ${className}`.trim()}
      data-status={status}
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    >
      {mark.path ? (
        <path
          d={mark.path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {mark.points.map(([x, y], index) => (
        <rect
          key={index}
          x={x - 0.9}
          y={y - 0.9}
          width="1.8"
          height="1.8"
          rx=".55"
        />
      ))}
    </svg>
  );
}
