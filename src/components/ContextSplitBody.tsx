import type { ReactNode } from "react";

/** The stable index/detail stack shared by Files preview and Changes. */
export function ContextSplitBody({
  mode,
  header,
  index,
  detail,
}: {
  mode: "files" | "changes";
  header: ReactNode;
  index: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div className={`res__body res__body--${mode}`}>
      <div className="res__index">
        {header}
        <div className="res__list" data-pane-scroll-active="true">
          {index}
        </div>
      </div>
      {detail}
    </div>
  );
}
