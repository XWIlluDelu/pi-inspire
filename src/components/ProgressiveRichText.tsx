import { Component, lazy, memo, type ReactNode, Suspense } from "react";
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

class RichTextLoadBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Show exact safe text immediately, then upgrade to Markdown, KaTeX, and
 * syntax highlighting when their deferred chunk is available. */
export const ProgressiveRichText = memo(function ProgressiveRichText(
  props: RichTextProps,
) {
  const fallback = <PlainRichText {...props} />;
  return (
    <RichTextLoadBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <RichTextSurface {...props} />
      </Suspense>
    </RichTextLoadBoundary>
  );
});
