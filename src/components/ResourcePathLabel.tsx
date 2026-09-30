interface ResourcePathLabelProps {
  path: string;
  className?: string;
}

/** Keep the file/directory name visible while CSS elides the parent path.
 * The exact value remains exposed to assistive technology and as a title. */
export function ResourcePathLabel({
  path,
  className = "",
}: ResourcePathLabelProps) {
  const withoutTrailingSlash = path.replace(/[\\/]+$/, "");
  const leafStart =
    Math.max(
      withoutTrailingSlash.lastIndexOf("/"),
      withoutTrailingSlash.lastIndexOf("\\"),
    ) + 1;
  const parent = path.slice(0, leafStart);
  return (
    <span
      className={className ? `resource-path ${className}` : "resource-path"}
      title={path}
    >
      <span className="resource-path__visible" aria-hidden>
        {parent ? (
          <span className="resource-path__parent">{parent}</span>
        ) : null}
        <span className="resource-path__leaf">
          <bdi>{path.slice(leafStart)}</bdi>
        </span>
      </span>
      <span className="visually-hidden">{path}</span>
    </span>
  );
}
