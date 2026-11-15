import { useEffect, useState } from "react";

type ImageLoader = (signal: AbortSignal) => Promise<Blob | null>;
interface ImageUrl {
  src?: string;
  error?: string;
}

/** Own one blob read and its temporary URL. A stable loader identifies the
 * caller's read scope; replacing it retires both the read and its result. */
export function useImageUrl(load: ImageLoader): ImageUrl {
  const [result, setResult] = useState<{
    load: ImageLoader;
    image: ImageUrl;
  }>();

  useEffect(() => {
    const request = new AbortController();
    let objectUrl: string | undefined;
    setResult(undefined);
    void load(request.signal)
      .then((blob) => {
        if (request.signal.aborted) return;
        if (!blob) throw new Error("Image unavailable");
        objectUrl = URL.createObjectURL(blob);
        setResult({ load, image: { src: objectUrl } });
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted)
          setResult({
            load,
            image: {
              error:
                reason instanceof Error ? reason.message : "Image unavailable",
            },
          });
      });
    return () => {
      request.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [load]);

  return result?.load === load ? result.image : {};
}
