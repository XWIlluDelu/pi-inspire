import type { ComponentProps } from "react";

type Props = Omit<ComponentProps<"svg">, "children" | "width" | "height"> & {
  size?: number;
  status: "success" | "error";
};

/** Settled counterpart of PiLoader. Light links keep the 3×3 check legible at 12px. */
export function PiStatus({
  size = 14,
  status,
  className = "",
  ...props
}: Props) {
  const success = status === "success";
  const points = success
    ? [
        [3.1, 8],
        [8, 12.9],
        [12.9, 3.1],
      ]
    : [
        [3.1, 3.1],
        [12.9, 3.1],
        [8, 8],
        [3.1, 12.9],
        [12.9, 12.9],
      ];
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
      <path
        d={
          success
            ? "M3.1 8 8 12.9 12.9 3.1"
            : "M3.1 3.1 12.9 12.9M12.9 3.1 3.1 12.9"
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {points.map(([x, y], index) => (
        <rect
          key={index}
          x={x! - 0.9}
          y={y! - 0.9}
          width="1.8"
          height="1.8"
          rx=".55"
        />
      ))}
    </svg>
  );
}
