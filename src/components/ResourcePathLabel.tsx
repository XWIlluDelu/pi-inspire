interface ResourcePathLabelProps {
  path: string;
  className?: string;
}

/** A path label with native CSS truncation. The exact value remains exposed
 * to assistive technology and as a hover title. */
export function ResourcePathLabel({
  path,
  className = "",
}: ResourcePathLabelProps) {
  return (
    <span
      className={className ? `resource-path ${className}` : "resource-path"}
      title={path}
    >
      <span className="resource-path__visible" aria-hidden>
        {path}
      </span>
      <span className="visually-hidden">{path}</span>
    </span>
  );
}
