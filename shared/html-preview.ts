/** HTML stays static until a paired browser explicitly requests execution. */
export const HTML_PREVIEW_BYTES = 256 * 1024;

export interface HtmlPreviewResponse {
  id: string;
  url: string;
}
