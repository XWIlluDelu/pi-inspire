const COMPACT_RESOURCE_TAIL_LENGTH = 14;

interface ResourcePathProjection {
  fullStart: string;
  context: string;
  nameStart: string;
  nameEnd: string;
}

function compactResourceParent(parent: string, separator: string): string {
  let prefix = "";
  let remainder = parent;
  const filePrefix = /^file:[\\/]{2,}/u.exec(remainder)?.[0];
  const drivePrefix = /^[A-Za-z]:/u.exec(remainder)?.[0];
  if (filePrefix) {
    prefix = filePrefix;
    remainder = remainder.slice(filePrefix.length);
  } else if (drivePrefix) {
    prefix = `${drivePrefix}${separator}`;
    remainder = remainder.slice(drivePrefix.length).replace(/^[\\/]+/u, "");
  } else if (/^[\\/]/u.test(remainder)) {
    prefix = separator;
    remainder = remainder.replace(/^[\\/]+/u, "");
  }

  const segments = remainder.split(/[\\/]+/u).filter(Boolean);
  if (segments.length <= 2) return `${parent}${separator}`;
  if (prefix)
    return `${prefix}…${separator}${segments.slice(-2).join(separator)}${separator}`;
  return `${segments[0]}${separator}…${separator}`;
}

function projectResourcePath(path: string): ResourcePathProjection {
  const trailingSeparators = /[\\/]+$/u.exec(path)?.[0] ?? "";
  const normalized = trailingSeparators
    ? path.slice(0, -trailingSeparators.length)
    : path;
  const slash = normalized.lastIndexOf("/");
  const backslash = normalized.lastIndexOf("\\");
  const separatorIndex = Math.max(slash, backslash);
  const separator = backslash > slash ? "\\" : "/";
  const parent = separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : "";
  const name =
    separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
  const characters = Array.from(name);
  const extension = /\.[^./\\]{1,12}$/u.exec(name)?.[0] ?? "";
  const extensionLength = Array.from(extension).length;
  const tailLength = Math.min(
    characters.length,
    Math.max(extensionLength, COMPACT_RESOURCE_TAIL_LENGTH),
  );
  const nameStart =
    tailLength > 0
      ? characters.slice(0, -tailLength).join("")
      : characters.join("");
  const nameEnd =
    (tailLength > 0 ? characters.slice(-tailLength).join("") : "") +
    trailingSeparators;
  return {
    fullStart: nameEnd ? path.slice(0, -nameEnd.length) : path,
    context: parent ? compactResourceParent(parent, separator) : "",
    nameStart,
    nameEnd,
  };
}

/** A visual path projection. Its owning resource action retains the complete
 * path as its accessible name and target. */
export function ResourcePathLabel({ path }: { path: string }) {
  const projection = projectResourcePath(path);
  return (
    <span className="resource-path">
      <span className="resource-path__full" aria-hidden>
        {projection.fullStart ? (
          <span className="resource-path__full-start">
            {projection.fullStart}
          </span>
        ) : null}
        {projection.nameEnd ? (
          <span className="resource-path__full-end">
            <span>{projection.nameEnd}</span>
          </span>
        ) : null}
      </span>
      <span className="resource-path__compact" aria-hidden>
        {projection.context ? (
          <span className="resource-path__context">{projection.context}</span>
        ) : null}
        <span className="resource-path__name-start">
          {projection.nameStart}
        </span>
        {projection.nameEnd ? (
          <span className="resource-path__name-end">
            <span>{projection.nameEnd}</span>
          </span>
        ) : null}
      </span>
    </span>
  );
}
