import clsx from "clsx";
import { Camera, ImagePlus, Trash } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { useMediaQuery } from "@/lib/device";
import { firstPictureFile, type Crop, type Picture } from "@/lib/pictures";
import { PictureCropDialog } from "./PictureCropDialog";

/** Phones and tablets, where a file input can open the camera. */
const TOUCH_QUERY = "(pointer: coarse)";

/**
 * A round picture with the ways to change it: choose a file, drop one on the circle, paste one
 * anywhere while this is on screen, take a photo on a phone, and remove it. Every new picture goes
 * through the crop step; `onCropped` draws what it needs and stores it.
 */
export function PictureField({
  src,
  placeholder,
  hasPicture,
  busy = false,
  large = false,
  onCropped,
  onRemove,
  extra,
}: {
  /** Where the circle shows the picture from; null while there is none to show. */
  src: string | null;
  /** What the circle shows without a picture. */
  placeholder?: ReactNode;
  /** Whether there is a picture to remove (it may exist without being showable). */
  hasPicture: boolean;
  busy?: boolean;
  large?: boolean;
  onCropped: (picture: Picture, crop: Crop) => Promise<void> | void;
  onRemove: () => void;
  /** More ways to get a picture, e.g. a company's logo; `open` starts the crop step with a file. */
  extra?: (open: (file: Blob) => void) => ReactNode;
}) {
  const { t } = useT();
  const touch = useMediaQuery(TOUCH_QUERY);
  const [file, setFile] = useState<Blob | null>(null);
  const [over, setOver] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  // A picture pasted anywhere lands here; text still pastes as text.
  useEffect(() => {
    if (file || busy) return;
    const paste = (event: ClipboardEvent) => {
      const pasted = firstPictureFile(event.clipboardData?.files);
      if (!pasted) return;
      event.preventDefault();
      setFile(pasted);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, [file, busy]);

  const picked = (input: HTMLInputElement) => {
    const chosen = input.files?.[0];
    input.value = "";
    if (chosen) setFile(chosen);
  };

  const dragOver = (event: DragEvent) => {
    if (busy || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setOver(true);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (busy) return;
    // A picture among the files if there is one; otherwise the first file, which the crop step refuses.
    const dropped = firstPictureFile(event.dataTransfer.files) ?? event.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  };

  const cropped = async (picture: Picture, crop: Crop) => {
    // The crop step closes first; storing may take a moment and shows on the circle.
    setFile(null);
    await onCropped(picture, crop);
  };

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => chooser.current?.click()}
        onDragOver={dragOver}
        onDragEnter={dragOver}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        aria-label={hasPicture ? t("picture.change") : t("picture.choose")}
        className={clsx(
          "group relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-pink-tint text-pink-ink transition-shadow focus-visible:shadow-focus focus-visible:outline-none",
          large ? "size-24" : "size-[72px]",
          over && "ring-4 ring-pink",
        )}
      >
        {src ? (
          <img src={src} alt="" draggable={false} className="size-full object-cover" />
        ) : (
          (placeholder ?? <ImagePlus className="size-7" aria-hidden />)
        )}
        <span
          aria-hidden
          className={clsx(
            "absolute inset-0 grid place-items-center bg-[#1c1420]/45 text-white opacity-0 transition-opacity group-hover:opacity-100",
            (over || busy) && "opacity-100",
          )}
        >
          {busy ? (
            <span className="size-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <Camera className="size-6" />
          )}
        </span>
      </button>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" icon={ImagePlus} disabled={busy} onClick={() => chooser.current?.click()}>
            {t("picture.choose")}
          </Button>
          {touch && (
            <Button size="sm" icon={Camera} disabled={busy} onClick={() => camera.current?.click()}>
              {t("picture.camera")}
            </Button>
          )}
          {extra?.(setFile)}
          {hasPicture && (
            <Button size="sm" variant="ghost" icon={Trash} disabled={busy} onClick={onRemove}>
              {t("picture.remove")}
            </Button>
          )}
        </div>
        <p className="text-[12.5px] text-muted">{t("picture.hint")}</p>
      </div>
      <input ref={chooser} type="file" accept="image/*" hidden onChange={(event) => picked(event.target)} />
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="user"
        hidden
        onChange={(event) => picked(event.target)}
      />
      <PictureCropDialog file={file} onCancel={() => setFile(null)} onCropped={cropped} />
    </div>
  );
}
