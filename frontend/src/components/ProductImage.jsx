import { useEffect, useState } from "react";
import {
  browserCanDisplayImageUrl,
  isHeicOrHeifUrl,
  productImagePlaceholder,
} from "../utils/productImage.js";

/**
 * Renders a product image with HEIC awareness, no-referrer (helps some CDNs),
 * and a fallback when the URL fails to load.
 */
export default function ProductImage({
  url,
  alt,
  className,
  loading = "lazy",
}) {
  const rawUrl = (url ?? "").trim();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [rawUrl]);

  let src;
  if (!browserCanDisplayImageUrl(rawUrl)) {
    src = productImagePlaceholder(
      isHeicOrHeifUrl(rawUrl) ? "HEIC — use JPG or PNG" : "No image"
    );
  } else if (failed) {
    src = productImagePlaceholder("Image unavailable");
  } else {
    src = rawUrl;
  }

  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading={loading}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        if (browserCanDisplayImageUrl(rawUrl)) setFailed(true);
      }}
    />
  );
}
