const RESOURCE_TAIL_LENGTH = 14;

interface ResourcePathProjection {
  leading: string;
  tail: string;
}

export function projectResourcePath(path: string): ResourcePathProjection {
  const trailingSeparators = /[\\/]+$/u.exec(path)?.[0] ?? "";
  const normalized = trailingSeparators
    ? path.slice(0, -trailingSeparators.length)
    : path;
  const separatorIndex = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  const name =
    separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
  const characters = Array.from(name);
  const extension = /\.[^./\\]{1,12}$/u.exec(name)?.[0] ?? "";
  const tailLength = Math.min(
    characters.length,
    Math.max(Array.from(extension).length, RESOURCE_TAIL_LENGTH),
  );
  const tail =
    (tailLength > 0 ? characters.slice(-tailLength).join("") : "") +
    trailingSeparators;
  return {
    leading: tail ? path.slice(0, -tail.length) : path,
    tail,
  };
}

/** A visual path projection. Its owning resource action retains the complete
 * path as its accessible name and target. */
export function ResourcePathLabel({ path }: { path: string }) {
  const projection = projectResourcePath(path);
  return (
    <span className="resource-path" aria-hidden>
      {projection.leading ? (
        <span className="resource-path__leading">{projection.leading}</span>
      ) : null}
      {projection.tail ? (
        <span className="resource-path__tail">
          <span>{projection.tail}</span>
        </span>
      ) : null}
    </span>
  );
}
