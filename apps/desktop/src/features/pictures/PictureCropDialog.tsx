import { Minus, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { translate, useT } from "@/i18n";
import {
  MAX_ZOOM,
  PICTURE_MAX_BYTES,
  PictureError,
  clampCrop,
  initialCrop,
  moveCrop,
  readPicture,
  zoomCrop,
  zoomOf,
  type Crop,
  type Picture,
} from "@/lib/pictures";
import { toast } from "@/state/toasts";

/** Side of the square crop area on screen, in CSS pixels; it fits the narrowest phone. */
export const CROP_VIEW = 256;
/** Keyboard steps: arrows move this far (Shift: four times), + and − zoom by this factor. */
const MOVE_STEP = 8;
const ZOOM_STEP = 1.1;

/** Why a picture couldn't be used, in the reader's words. */
export function pictureErrorText(error: unknown): string {
  const problem = error instanceof PictureError ? error.problem : "unreadable";
  if (problem === "tooLarge") {
    return translate("picture.error.tooLarge", { size: `${Math.round(PICTURE_MAX_BYTES / 1024 / 1024)} MB` });
  }
  return translate(problem === "notImage" ? "picture.error.notImage" : "picture.error.unreadable");
}

/**
 * Crops a picture file to a circle: drag or touch to move it, wheel, pinch or the slider to zoom,
 * arrows and +/− on the keyboard. `onCropped` gets the decoded picture and where it lies under
 * the circle of CROP_VIEW; the caller draws what it needs from them and then closes the picture.
 */
export function PictureCropDialog({
  file,
  onCancel,
  onCropped,
}: {
  /** The file to crop; the dialog is open while there is one. */
  file: Blob | null;
  onCancel: () => void;
  onCropped: (picture: Picture, crop: Crop) => Promise<void> | void;
}) {
  const { t } = useT();
  return (
    <Dialog open={file !== null} onClose={onCancel} title={t("picture.crop.title")} width="sm">
      {file && <Cropper key={identity(file)} file={file} onCancel={onCancel} onCropped={onCropped} />}
    </Dialog>
  );
}

const ids = new WeakMap<Blob, number>();
let nextId = 1;
/** A fresh cropper for every file, even two with the same name. */
function identity(file: Blob): number {
  let id = ids.get(file);
  if (id === undefined) {
    id = nextId++;
    ids.set(file, id);
  }
  return id;
}

function Cropper({
  file,
  onCancel,
  onCropped,
}: {
  file: Blob;
  onCancel: () => void;
  onCropped: (picture: Picture, crop: Crop) => Promise<void> | void;
}) {
  const { t } = useT();
  const [picture, setPicture] = useState<Picture | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const handedOver = useRef(false);
  const hintId = useId();
  // The picture loads once per file, whatever the parent hands in as callbacks meanwhile.
  const cancel = useRef(onCancel);
  useEffect(() => {
    cancel.current = onCancel;
  });

  useEffect(() => {
    let cancelled = false;
    let loaded: Picture | null = null;
    readPicture(file).then(
      (result) => {
        if (cancelled) {
          result.close();
          return;
        }
        loaded = result;
        setPicture(result);
        setCrop(initialCrop(result.width, result.height, CROP_VIEW));
      },
      (error: unknown) => {
        if (cancelled) return;
        toast(pictureErrorText(error), "error");
        cancel.current();
      },
    );
    return () => {
      cancelled = true;
      // Once handed over, the caller closes it after drawing.
      if (loaded && !handedOver.current) loaded.close();
    };
  }, [file]);

  // The picture as it lies under the circle, drawn sharp on high-density screens.
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context || !picture || !crop) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = CROP_VIEW * ratio;
    element.height = CROP_VIEW * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.imageSmoothingQuality = "high";
    context.clearRect(0, 0, CROP_VIEW, CROP_VIEW);
    context.drawImage(picture.source, crop.x, crop.y, picture.width * crop.scale, picture.height * crop.scale);
  }, [picture, crop]);

  // The wheel zooms; React listens passively, so this needs a listener of its own to keep the
  // dialog from scrolling.
  useEffect(() => {
    const element = area.current;
    if (!element || !picture) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002));
      setCrop((current) =>
        current
          ? zoomCrop(
              current,
              factor,
              event.clientX - box.left,
              event.clientY - box.top,
              picture.width,
              picture.height,
              CROP_VIEW,
            )
          : current,
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [picture]);

  if (!picture || !crop) {
    return (
      <div className="grid h-[340px] place-items-center text-[13px] text-muted" role="status">
        {t("picture.loading")}
      </div>
    );
  }

  const { width, height } = picture;
  const zoom = zoomOf(crop, width, height, CROP_VIEW);
  const zoomTo = (next: number) =>
    setCrop((current) =>
      current
        ? zoomCrop(
            current,
            next / zoomOf(current, width, height, CROP_VIEW),
            CROP_VIEW / 2,
            CROP_VIEW / 2,
            width,
            height,
            CROP_VIEW,
          )
        : current,
    );

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const before = pointers.current.get(event.pointerId);
    if (!before) return;
    const now = { x: event.clientX, y: event.clientY };
    const others = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId);
    pointers.current.set(event.pointerId, now);
    const other = others[0]?.[1];
    if (!other) {
      setCrop((current) =>
        current ? moveCrop(current, now.x - before.x, now.y - before.y, width, height, CROP_VIEW) : current,
      );
      return;
    }
    // Two fingers: zoom by how much further apart they are, around the point between them.
    const box = event.currentTarget.getBoundingClientRect();
    const was = Math.hypot(before.x - other.x, before.y - other.y);
    const is = Math.hypot(now.x - other.x, now.y - other.y);
    if (was < 1) return;
    const cx = (now.x + other.x) / 2 - box.left;
    const cy = (now.y + other.y) / 2 - box.top;
    setCrop((current) => (current ? zoomCrop(current, is / was, cx, cy, width, height, CROP_VIEW) : current));
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? MOVE_STEP * 4 : MOVE_STEP;
    // Like dragging: the picture goes the way the arrow points.
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      setCrop((current) => (current ? moveCrop(current, move[0], move[1], width, height, CROP_VIEW) : current));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomTo(zoom * ZOOM_STEP);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomTo(zoom / ZOOM_STEP);
    }
  };

  const use = async () => {
    setBusy(true);
    handedOver.current = true;
    try {
      await onCropped(picture, clampCrop(crop, width, height, CROP_VIEW));
    } catch (error) {
      toast(pictureErrorText(error), "error");
      handedOver.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4 px-6 pt-2 pb-6">
      <div
        ref={area}
        tabIndex={0}
        role="img"
        aria-label={t("picture.crop.area")}
        aria-describedby={hintId}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onKeyDown={keyDown}
        style={{ width: CROP_VIEW, height: CROP_VIEW }}
        className="relative shrink-0 cursor-grab touch-none overflow-hidden rounded-2xl bg-canvas select-none focus-visible:shadow-focus focus-visible:outline-none active:cursor-grabbing"
      >
        <canvas ref={canvas} style={{ width: CROP_VIEW, height: CROP_VIEW }} className="block" aria-hidden />
        {/* Everything outside the circle is dimmed; the circle is what people will see. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_200px_rgb(28_20_32/0.55)] ring-2 ring-white/80"
        />
      </div>
      <p id={hintId} className="text-center text-[12.5px] text-muted">
        {t("picture.crop.hint")}
      </p>
      <div className="flex w-full max-w-[280px] items-center gap-2">
        <IconButton icon={Minus} size="sm" label={t("picture.crop.zoomOut")} onClick={() => zoomTo(zoom / ZOOM_STEP)} />
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          aria-label={t("picture.crop.zoom")}
          onChange={(event) => zoomTo(Number(event.target.value))}
          className="min-w-0 flex-1 accent-pink"
        />
        <IconButton icon={Plus} size="sm" label={t("picture.crop.zoomIn")} onClick={() => zoomTo(zoom * ZOOM_STEP)} />
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void use()}>
          {t("picture.crop.use")}
        </Button>
      </div>
    </div>
  );
}
