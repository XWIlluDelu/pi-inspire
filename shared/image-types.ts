/** A browser may preview image media independently of how it is sent to Pi. */
export function isImageMimeType(value: string): boolean {
  return /^image\//iu.test(value);
}

/** Pi prompt images are a narrower set; other media remain ordinary files. */
export function isSupportedPromptImageMimeType(value: string): boolean {
  return /^image\/(?:png|jpe?g|gif|webp)$/iu.test(value);
}
