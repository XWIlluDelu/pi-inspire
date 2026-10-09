import { type SearchMatchRange, SearchMatchText } from "./SearchMatchText";

/** Parent directory for display; a root-level workspace file has none. */
export function parentPath(path: string): string | null {
  const end = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return end > 0 ? path.slice(0, end) : null;
}

interface ResourcePathLabelProps {
  path: string;
  className?: string;
  title?: string;
  matches?: readonly SearchMatchRange[];
}

/** Keep the file/directory name visible while CSS elides the parent path.
 * The displayed value remains exposed to assistive technology. */
export function ResourcePathLabel({
  path,
  className = "",
  title = path,
  matches = [],
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
      title={title}
    >
      <span className="resource-path__visible" aria-hidden>
        {parent ? (
          <span className="resource-path__parent">
            <SearchMatchText text={parent} ranges={matches} />
          </span>
        ) : null}
        <span className="resource-path__leaf">
          <bdi>
            <SearchMatchText
              text={path.slice(leafStart)}
              ranges={matches}
              offset={leafStart}
            />
          </bdi>
        </span>
      </span>
      <span className="visually-hidden">{path}</span>
    </span>
  );
}
