/** Reserve this action's alternate labels without imposing a shared button width. */
export function ButtonLabel({
  children,
  reserve,
}: {
  children: string;
  reserve: string | readonly string[];
}) {
  const labels = typeof reserve === "string" ? [reserve] : reserve;
  return (
    <span className="button-label">
      <span>{children}</span>
      {labels.map((label) => (
        <span key={label} className="button-label__reserve" aria-hidden="true">
          {label}
        </span>
      ))}
    </span>
  );
}
