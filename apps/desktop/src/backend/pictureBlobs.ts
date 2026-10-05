import type { SenderPicture } from "./types";

/** A picture as a data: URL, how the engine takes pictures from the page. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The picture couldn't be read."));
    reader.readAsDataURL(blob);
  });
}

/**
 * A company's logo for a contact's picture: the sender picture the app keeps for the address,
 * when it is a logo or website icon. Null for people and mail providers, or when it can't be read.
 */
export async function companyLogoFrom(picture: SenderPicture | null): Promise<Blob | null> {
  if (!picture) return null;
  try {
    const response = await fetch(picture.url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}
