import {
  AlertTriangle,
  File,
  FileCode,
  FileSearch,
  FileText,
  Image as ImageIcon,
  Loader2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { ResourceKind } from "../../shared/contracts";
import { formatBytes } from "../format";
import { collectResources, resourceIcon, type ResourceIcon, type ResourceRow } from "../resources";
import {
  MAX_MEDIA_PREVIEW_BYTES,
  store,
  TEXT_PREVIEW_BYTES,
  useAppState,
  type ResourcePreview,
} from "../store";
import { CodeBlock, RichText } from "./RichText";
import { ScrollRail } from "./ScrollRail";

const ICONS: Record<ResourceIcon, typeof File> = {
  image: ImageIcon,
  code: FileCode,
  text: FileText,
  file: File,
};

/** hljs language id for a previewed file name. */
function languageFor(name: string, kind: ResourceKind): string {
  if (kind === "markdown") return "markdown";
  if (kind === "html") return "html";
  const extension = /\.([A-Za-z0-9]{1,12})$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return extension || "plaintext";
}

function ResourceListRow({ row }: { row: ResourceRow }) {
  const state = useAppState();
  const selected = state.selectedResourceReference === row.reference;
  const Icon = ICONS[resourceIcon(row)];
  return (
    <button
      type="button"
      className={`res__row ${selected ? "res__row--active" : ""}`}
      aria-current={selected || undefined}
      title={row.reference}
      onClick={() => void store.openResource(row.reference ?? row.label)}
    >
      <Icon size={13} aria-hidden />
      <span className="res__row-name">{row.name}</span>
      <span className="res__row-source">{row.source === "tool" ? (row.toolName ?? "tool") : row.source}</span>
    </button>
  );
}

/** HTML renders as highlighted source by default; the sandboxed view is an
 * explicit, scriptless isolation step (blob URL already carries a strict CSP). */
function HtmlPreview({ name, text, objectUrl }: { name: string; text: string; objectUrl?: string }) {
  const [sandboxed, setSandboxed] = useState(false);
  return (
    <div className="res__preview-fill">
      <div className="res__preview-bar">
        <span className="res__preview-note">HTML is isolated: no scripts, forms, or remote loads.</span>
        {objectUrl ? (
          <button type="button" className="button" onClick={() => setSandboxed((value) => !value)}>
            {sandboxed ? "View source" : "Open in sandboxed view"}
          </button>
        ) : null}
      </div>
      {sandboxed && objectUrl ? (
        <iframe className="res__frame" sandbox="" src={objectUrl} title={`Sandboxed preview of ${name}`} />
      ) : (
        <CodeBlock language="html" code={text} />
      )}
    </div>
  );
}

function PreviewBody({ preview }: { preview: Extract<ResourcePreview, { status: "ready" }> }) {
  const { descriptor, text, truncated, objectUrl, contentUnavailable } = preview;
  if (contentUnavailable === "too-large") {
    return (
      <Unsupported
        descriptorName={descriptor.name}
        size={descriptor.size}
        reason={`Preview limit: ${formatBytes(MAX_MEDIA_PREVIEW_BYTES)}`}
      />
    );
  }
  const truncatedNote = truncated ? (
    <div className="res__preview-note">Truncated — first {formatBytes(TEXT_PREVIEW_BYTES)} shown.</div>
  ) : null;
  switch (descriptor.kind) {
    case "image":
      return objectUrl ? (
        <div className="res__preview-fill res__preview-media">
          <img src={objectUrl} alt={descriptor.name} />
        </div>
      ) : (
        <Unsupported descriptorName={descriptor.name} size={descriptor.size} />
      );
    case "pdf":
      return objectUrl ? (
        <div className="res__preview-fill">
          <iframe className="res__frame" sandbox="" src={objectUrl} title={`PDF preview of ${descriptor.name}`} />
          <a className="res__download" href={objectUrl} download={descriptor.name}>
            Download {descriptor.name}
          </a>
        </div>
      ) : (
        <Unsupported descriptorName={descriptor.name} size={descriptor.size} />
      );
    case "audio":
      return objectUrl ? (
        <div className="res__preview-fill res__preview-media">
          <audio controls src={objectUrl} />
        </div>
      ) : (
        <Unsupported descriptorName={descriptor.name} size={descriptor.size} />
      );
    case "video":
      return objectUrl ? (
        <div className="res__preview-fill res__preview-media">
          <video controls src={objectUrl} />
        </div>
      ) : (
        <Unsupported descriptorName={descriptor.name} size={descriptor.size} />
      );
    case "html":
      return (
        <>
          {truncatedNote}
          <HtmlPreview name={descriptor.name} text={text ?? ""} objectUrl={objectUrl} />
        </>
      );
    case "markdown":
      return (
        <div className="res__preview-fill res__preview-document">
          {truncatedNote}
          <RichText text={text ?? ""} variant="assistant" />
        </div>
      );
    case "text":
      return (
        <div className="res__preview-fill">
          {truncatedNote}
          <CodeBlock language={languageFor(descriptor.name, descriptor.kind)} code={text ?? ""} />
        </div>
      );
    default:
      return <Unsupported descriptorName={descriptor.name} size={descriptor.size} />;
  }
}

function Unsupported({ descriptorName, size, reason }: { descriptorName: string; size: number; reason?: string }) {
  return (
    <div className="res__state">
      <File size={18} aria-hidden />
      <p className="res__state-title">No preview available</p>
      <p className="res__state-hint">
        {descriptorName} · {formatBytes(size)}{reason ? ` · ${reason}` : ""}
      </p>
    </div>
  );
}

function PreviewRegion() {
  const state = useAppState();
  const preview = state.resourcePreview;
  if (!preview) {
    return (
      <div className="res__state" aria-live="polite">
        <p className="res__state-hint">Select a file above to preview it here.</p>
      </div>
    );
  }
  if (preview.status === "loading") {
    return (
      <div className="res__state" aria-live="polite">
        <Loader2 size={16} className="spin" aria-hidden />
        <p className="res__state-hint">Loading {preview.reference}…</p>
      </div>
    );
  }
  if (preview.status === "error") {
    return (
      <div className="res__state" role="alert">
        <AlertTriangle size={16} aria-hidden />
        <p className="res__state-title">Preview failed</p>
        <p className="res__state-hint">{preview.message}</p>
        <button type="button" className="button" onClick={() => void store.openResource(preview.reference)}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="res__preview" aria-live="polite">
      <div className="res__preview-title" title={preview.descriptor.reference}>
        {preview.descriptor.name}
        <span className="res__preview-size">{formatBytes(preview.descriptor.size)}</span>
      </div>
      <PreviewBody preview={preview} />
    </div>
  );
}

export function ResourcesPane() {
  const state = useAppState();
  const paneRef = useRef<HTMLElement>(null);
  // Extraction is a pure pass over the visible messages; recompute only when
  // the message list itself changes.
  const resources = useMemo(() => collectResources(state.messages), [state.messages]);
  const openNestedReference = (event: React.MouseEvent) => {
    const origin = event.target instanceof Element ? event.target.closest("[data-file-path]") : null;
    const reference = origin?.getAttribute("data-file-path");
    if (!reference) return;
    event.preventDefault();
    void store.openResource(reference);
  };
  return (
    <aside className="ctx res" aria-label="Files and resources" onClick={openNestedReference} ref={paneRef}>
      {/* Closing lives in the topbar toggle; the header stays a plain label. */}
      <div className="ctx__header">
        <span>Files</span>
        {resources.length > 0 ? <span className="ctx__count">{resources.length}</span> : null}
      </div>
      {resources.length === 0 ? (
        state.resourcePreview ? null : (
          <div className="empty-state">
            <FileSearch size={26} strokeWidth={1.5} aria-hidden />
            <span className="empty-state__title">No files yet</span>
            <span className="empty-state__hint">Files Pi reads, writes, or you mention appear here</span>
          </div>
        )
      ) : (
        <div className="res__list" aria-label="Referenced files">
          {resources.map((row) => (
            <ResourceListRow key={row.key} row={row} />
          ))}
        </div>
      )}
      <PreviewRegion />
      <ScrollRail container={paneRef} scroller=".res__list" variant="ctx" />
      <ScrollRail container={paneRef} scroller=".res__preview-fill" variant="ctx" />
    </aside>
  );
}
