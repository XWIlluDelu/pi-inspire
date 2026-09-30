import { lazy, memo, Suspense } from "react";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import type { RichTextVariant } from "./RichText";

const RichTextSurface = lazy(() =>
  import("./RichText").then((module) => ({ default: module.RichText })),
);

interface RichTextProps {
  text: string;
  variant?: RichTextVariant;
  inline?: boolean;
}

function PlainRichText({
  text,
  variant = "assistant",
  inline = false,
}: RichTextProps) {
  return (
    <div
      className={`rich-text rich-text--${variant} rich-text--deferred ${inline ? "rich-text--inline" : ""}`}
    >
      {text}
    </div>
  );
}

/** Show exact safe text immediately, then upgrade when the deferred chunk is
 * available. RichText owns parsing and stable math/code reuse; this boundary
 * only owns loading/failure and never delays or drops text deltas. */
export const ProgressiveRichText = memo(function ProgressiveRichText(
  props: RichTextProps,
) {
  const fallback = <PlainRichText {...props} />;
  return (
    <RenderErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <RichTextSurface {...props} />
      </Suspense>
    </RenderErrorBoundary>
  );
});
