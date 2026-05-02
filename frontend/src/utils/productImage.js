/**
 * HEIC/HEIF (common iPhone exports) cannot be decoded by img elements in
 * Chrome/Firefox/Safari — the upload succeeds to S3 but the catalog will
 * always show a broken/placeholder image until you use JPEG/PNG/WebP.
 */
const HEIC_PATH_RE = /\.(heic|heif)(\?|#|$)/i;

export function isHeicOrHeifUrl(url) {
  if (!url || typeof url !== "string") return false;
  return HEIC_PATH_RE.test(url.trim());
}

/** Returns true if we should attempt to load `url` in an img element. */
export function browserCanDisplayImageUrl(url) {
  const u = url?.trim();
  if (!u) return false;
  if (isHeicOrHeifUrl(u)) return false;
  return true;
}

export function productImagePlaceholder(shortLabel = "No image") {
  const text = String(shortLabel).replace(/</g, " ").slice(0, 80);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="100%" height="100%" fill="#f1f5f9"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#64748b" font-family="system-ui,sans-serif" font-size="13">${text}</text></svg>`
  )}`;
}
