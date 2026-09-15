/** Pictures larger than this aren't read at all. */
const MAX_INPUT = 8 * 1024 * 1024;

/**
 * A picture file as a data URL, scaled down to `maxWidth` so it fits a signature and stays small.
 * PNG and GIF keep transparency as PNG; everything else becomes JPEG.
 */
export async function pictureAsDataUrl(file: File, maxWidth = 480): Promise<string> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") throw new Error("not a picture");
  if (file.size > MAX_INPUT) throw new Error("too big");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const keepsTransparency = file.type === "image/png" || file.type === "image/gif";
  return keepsTransparency ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.88);
}
