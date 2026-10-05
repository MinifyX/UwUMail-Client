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
  if (!picture || picture.kind === "photo") return null;
  // SVG logos come as data: URLs, which the app's own policy doesn't let fetch() read.
  if (picture.url.startsWith("data:")) return dataUrlToBlob(picture.url);
  try {
    const response = await fetch(picture.url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

/** The largest picture read from a data: URL, about 2 MB of bytes. */
const MAX_DATA_URL = 3 * 1024 * 1024;

/** A data: URL's picture as a Blob, read without fetch(); null for anything that isn't a picture. */
export function dataUrlToBlob(url: string): Blob | null {
  if (url.length > MAX_DATA_URL) return null;
  const match = /^data:(image\/[\w.+-]+)(?:;[\w-]+=[\w-]+)*(;base64)?,(.*)$/is.exec(url);
  if (!match) return null;
  const [, type, base64, data] = match;
  try {
    const bytes = base64
      ? Uint8Array.from(atob(data!), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(data!));
    return bytes.length > 0 ? new Blob([bytes], { type: type!.toLowerCase() }) : null;
  } catch {
    return null;
  }
}
