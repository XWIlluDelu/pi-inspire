import { type ComponentPropsWithoutRef, type ReactNode } from "react";
import type { GitFileChange } from "../../shared/contracts";
import { fileIconForPath } from "../file-icons";
import { gitDecorationForChange, presentGitFacet } from "../git-presentation";

export function FileIndexRow({
  file,
  name,
  context,
  stacked,
  mark,
  change,
  unavailable,
  className = "",
  ...button
}: Omit<ComponentPropsWithoutRef<"button">, "children" | "name"> & {
  file: string;
  name: ReactNode;
  context?: ReactNode;
  stacked?: boolean;
  mark?: ReactNode;
  change?: GitFileChange;
  unavailable?: ReactNode;
}) {
  const Icon = fileIconForPath(file);
  const decoration = gitDecorationForChange(change);
  const facet = presentGitFacet(change);
  const gitClass = decoration ? ` git-deco--${decoration}` : "";
  return (
    <button type="button" className={`file-row ${className}`} {...button}>
      <Icon size={13} aria-hidden />
      <span className="file-row__label" data-stacked={stacked || undefined}>
        <span className={`file-row__name${gitClass}`}>{name}</span>
        {mark}
        {context && <span className="file-row__context">{context}</span>}
      </span>
      {facet ? (
        <span
          className={`git-mark${gitClass}`}
          role="img"
          aria-label={facet.label}
          title={facet.label}
        >
          {facet.mark}
        </span>
      ) : unavailable ? (
        <span className="file-row__warning">{unavailable}</span>
      ) : null}
    </button>
  );
}
