import { useLayoutEffect, useMemo, useRef, useState } from "react";

interface LexicalPath {
  segments: string[];
  separator: string;
  prefix: string;
  trailing: string;
  rootSegments: number;
}

const resizeCallbacks = new WeakMap<Element, () => void>();
let sharedResizeObserver: ResizeObserver | null = null;
let resizeObserverConstructor: typeof ResizeObserver | null = null;

function observeResize(element: Element, callback: () => void) {
  if (typeof ResizeObserver === "undefined") return () => undefined;
  if (!sharedResizeObserver || resizeObserverConstructor !== ResizeObserver) {
    sharedResizeObserver?.disconnect();
    resizeObserverConstructor = ResizeObserver;
    sharedResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) resizeCallbacks.get(entry.target)?.();
    });
  }
  resizeCallbacks.set(element, callback);
  sharedResizeObserver.observe(element);
  return () => {
    resizeCallbacks.delete(element);
    sharedResizeObserver?.unobserve(element);
  };
}

function parsePath(path: string): LexicalPath {
  const trailing = /[\\/]+$/u.exec(path)?.[0] ?? "";
  const withoutTrailing = trailing ? path.slice(0, -trailing.length) : path;
  const filePrefix = withoutTrailing.startsWith("file:///")
    ? "file:///"
    : withoutTrailing.startsWith("file://")
      ? "file://"
      : "";
  const body = withoutTrailing.slice(filePrefix.length);
  const matches = [...body.matchAll(/[^\\/]+/gu)];
  if (matches.length === 0)
    return {
      segments: [],
      separator: "/",
      prefix: path,
      trailing: "",
      rootSegments: 0,
    };
  const first = matches[0]!;
  const second = matches[1];
  const separator = second
    ? body.slice((first.index ?? 0) + first[0].length, second.index)
    : path.includes("\\")
      ? "\\"
      : "/";
  const prefix = `${filePrefix}${body.slice(0, first.index ?? 0)}`;
  return {
    segments: matches.map((match) => match[0]),
    separator: separator || "/",
    prefix,
    trailing,
    rootSegments: prefix.startsWith("\\\\") ? 2 : 1,
  };
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

function middleTruncate(value: string, limit: number): string {
  const characters = graphemes(value);
  if (characters.length <= limit) return value;
  if (limit <= 1) return "…";
  const extensionStart = value.lastIndexOf(".");
  const extension =
    extensionStart > 0 ? graphemes(value.slice(extensionStart)) : [];
  if (extension.length > 0 && extension.length < limit) {
    const headLength = limit - extension.length - 1;
    return `${characters.slice(0, headLength).join("")}…${extension.join("")}`;
  }
  const remaining = limit - 1;
  const tailLength = Math.max(1, Math.floor(remaining / 3));
  const headLength = remaining - tailLength;
  return `${characters.slice(0, headLength).join("")}…${characters
    .slice(characters.length - tailLength)
    .join("")}`;
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

/**
 * Produces path projections from most to least informative. The component
 * measures these against its actual inline width and chooses the first fit.
 */
export function resourcePathCandidates(path: string): string[] {
  const parsed = parsePath(path);
  if (parsed.segments.length === 0) return [path];
  const { segments, separator, prefix, trailing, rootSegments } = parsed;
  const leaf = segments.at(-1)!;
  const parent = segments.at(-2);
  const root = `${prefix}${segments.slice(0, rootSegments).join(separator)}`;
  const candidates = [path];
  if (parent && segments.length > rootSegments + 2)
    candidates.push(
      `${root}${separator}…${separator}${parent}${separator}${leaf}${trailing}`,
    );
  if (parent)
    candidates.push(`…${separator}${parent}${separator}${leaf}${trailing}`);
  candidates.push(`${leaf}${trailing}`);
  for (const limit of [48, 40, 32, 28, 24, 20, 16, 12, 8, 4, 3, 2, 1])
    candidates.push(`${middleTruncate(leaf, limit)}${trailing}`);
  return unique(candidates);
}

/** Width-aware visual path label that retains the full semantic value for
 * assistive technology and tooltips. */
export function ResourcePathLabel({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const candidates = useMemo(() => resourcePathCandidates(path), [path]);
  const rootRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [candidateIndex, setCandidateIndex] = useState(0);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const measure = measureRef.current;
    if (!root || !measure) return;
    const chooseCandidate = () => {
      const width = root.clientWidth;
      if (width <= 0) return;
      let next = candidates.length - 1;
      for (let index = 0; index < candidates.length; index += 1) {
        measure.textContent = candidates[index]!;
        if (measure.scrollWidth <= width) {
          next = index;
          break;
        }
      }
      measure.textContent = "";
      setCandidateIndex(next);
    };
    chooseCandidate();
    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) chooseCandidate();
    });
    const stopObserving = observeResize(root, chooseCandidate);
    return () => {
      active = false;
      stopObserving();
    };
  }, [candidates]);

  return (
    <span
      ref={rootRef}
      className={`resource-path${className ? ` ${className}` : ""}`}
      title={path}
    >
      <span className="visually-hidden">{path}</span>
      <span className="resource-path__visible" aria-hidden>
        {candidates[candidateIndex] ?? candidates.at(-1)}
      </span>
      <span ref={measureRef} className="resource-path__measure" aria-hidden />
    </span>
  );
}
