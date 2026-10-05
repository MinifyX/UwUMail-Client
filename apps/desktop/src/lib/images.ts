/** Pictures larger than this aren't read at all. */
const MAX_INPUT = 8 * 1024 * 1024;

/** Widths tried one after the other until the picture fits its byte budget. */
const WIDTHS = [480, 360, 240, 160, 120];

/**
 * A picture file as a data URL, scaled down to `maxWidth` so it fits a signature and stays small.
 * PNG and GIF keep transparency as PNG; everything else becomes JPEG. With `maxBytes` the picture
 * shrinks further until its data URL fits, and fails when even the smallest size doesn't.
 */
export async function pictureAsDataUrl(file: File, maxWidth = 480, maxBytes = Infinity): Promise<string> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") throw new Error("not a picture");
  if (file.size > MAX_INPUT) throw new Error("too big");
  const bitmap = await createImageBitmap(file);
  try {
    const keepsTransparency = file.type === "image/png" || file.type === "image/gif";
    for (const width of [maxWidth, ...WIDTHS.filter((w) => w < maxWidth)]) {
      const scale = Math.min(1, width / bitmap.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const url = keepsTransparency ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.85);
      if (url.length <= maxBytes) return url;
      // Already as small as the picture itself: shrinking further changes nothing.
      if (scale === 1 && bitmap.width <= WIDTHS[WIDTHS.length - 1]!) break;
    }
    throw new Error("too big");
  } finally {
    bitmap.close();
  }
}
