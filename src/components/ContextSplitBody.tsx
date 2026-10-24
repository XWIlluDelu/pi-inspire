import type { ReactNode } from "react";

/** The stable index/detail stack shared by Files preview and Changes. */
export function ContextSplitBody({
  mode,
  header,
  index,
  detail,
  className = "",
  indexHidden = false,
}: {
  mode: "files" | "changes";
  header: ReactNode;
  index: ReactNode;
  detail: ReactNode;
  className?: string;
  indexHidden?: boolean;
}) {
  return (
    <div
      className={`res__body res__body--${mode} res__body--split ${className}`}
    >
      <div className="res__index" hidden={indexHidden}>
        {header}
        <div className="res__list" data-pane-scroll-active="true">
          {index}
        </div>
      </div>
      {detail}
    </div>
  );
}
