import { describe, expect, it, vi } from "vitest";
import {
  CONTACT_PHOTO,
  MAX_ZOOM,
  PICTURE_MAX_BYTES,
  PROFILE_PICTURE,
  PictureError,
  clampCrop,
  firstPictureFile,
  initialCrop,
  moveCrop,
  pictureDimensions,
  pictureFileProblem,
  readPicture,
  renderPicture,
  renderPictureBlob,
  sourceSquare,
  zoomCrop,
  zoomOf,
  type OutputCanvas,
} from "./pictures";

const VIEW = 256;

/** A canvas that records what was drawn and "encodes" in whatever type it is asked for. */
function fakeCanvas(encodes: (type: string) => string = (type) => type) {
  const drawn: unknown[][] = [];
  const fills: { style: unknown; rect: number[] }[] = [];
  const context = {
    fillStyle: "" as unknown,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low" as ImageSmoothingQuality,
    fillRect(...rect: number[]) {
      fills.push({ style: context.fillStyle, rect });
    },
    drawImage(...args: unknown[]) {
      drawn.push(args);
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toDataURL: vi.fn((type: string, quality: number) => `data:${encodes(type)};base64,${quality}`),
    toBlob: vi.fn((done: (blob: Blob | null) => void, type: string) => done(new Blob(["x"], { type: encodes(type) }))),
  };
  return { canvas, context, drawn, fills, create: () => canvas as unknown as OutputCanvas };
}

describe("placing a picture under the circle", () => {
  it("starts with the short side filling the square, centred", () => {
    expect(initialCrop(1000, 500, VIEW)).toEqual({ scale: 0.512, x: -128, y: 0 });
    expect(initialCrop(300, 600, VIEW)).toEqual({ scale: VIEW / 300, x: 0, y: -128 });
  });

  it("never lets an empty edge into the square", () => {
    const start = initialCrop(1000, 500, VIEW);
    expect(moveCrop(start, 500, 40, 1000, 500, VIEW)).toEqual({ scale: 0.512, x: 0, y: 0 });
    expect(moveCrop(start, -500, -40, 1000, 500, VIEW)).toEqual({ scale: 0.512, x: -256, y: 0 });
  });

  it("zooms around a point that stays in place, between covering and eight times that", () => {
    const start = initialCrop(1000, 1000, VIEW);
    const zoomed = zoomCrop(start, 2, 64, 64, 1000, 1000, VIEW);
    expect(zoomOf(zoomed, 1000, 1000, VIEW)).toBeCloseTo(2);
    // The picture point under (64, 64) is still there.
    expect((64 - zoomed.x) / zoomed.scale).toBeCloseTo((64 - start.x) / start.scale);
    expect(zoomOf(zoomCrop(start, 100, 0, 0, 1000, 1000, VIEW), 1000, 1000, VIEW)).toBeCloseTo(MAX_ZOOM);
    expect(zoomCrop(start, 0.1, 0, 0, 1000, 1000, VIEW)).toEqual(start);
    expect(clampCrop({ scale: 0, x: 5, y: 5 }, 1000, 1000, VIEW)).toEqual(start);
  });

  it("knows which square of the picture ends up in the output", () => {
    expect(sourceSquare({ scale: 0.5, x: -100, y: -20 }, VIEW)).toEqual({ x: 200, y: 40, size: 512 });
  });
});

describe("the cropped picture", () => {
  const picture = { source: {} as CanvasImageSource };

  it("is a 256 × 256 JPEG at quality 0.85 for a contact, on white", () => {
    const fake = fakeCanvas();
    const uri = renderPicture(picture, { scale: 0.5, x: -100, y: -20 }, VIEW, CONTACT_PHOTO, fake.create);
    expect(uri).toBe("data:image/jpeg;base64,0.85");
    expect([fake.canvas.width, fake.canvas.height]).toEqual([256, 256]);
    expect(fake.canvas.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.85);
    expect(fake.fills).toEqual([{ style: "#ffffff", rect: [0, 0, 256, 256] }]);
    expect(fake.drawn).toEqual([[picture.source, 200, 40, 512, 512, 0, 0, 256, 256]]);
  });

  it("is a 512 × 512 JPEG file for the profile picture", async () => {
    const fake = fakeCanvas();
    const blob = await renderPictureBlob(picture, initialCrop(800, 600, VIEW), VIEW, PROFILE_PICTURE, fake.create);
    expect(blob.type).toBe("image/jpeg");
    expect([fake.canvas.width, fake.canvas.height]).toEqual([512, 512]);
    expect(fake.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.9);
  });

  it("is refused rather than stored as something else when the browser can't write JPEG", async () => {
    const fake = fakeCanvas(() => "image/png");
    expect(() => renderPicture(picture, initialCrop(10, 10, VIEW), VIEW, CONTACT_PHOTO, fake.create)).toThrow(
      PictureError,
    );
    await expect(
      renderPictureBlob(picture, initialCrop(10, 10, VIEW), VIEW, PROFILE_PICTURE, fake.create),
    ).rejects.toThrow(PictureError);
  });
});

describe("picture files", () => {
  it("takes pictures only, and not huge ones", () => {
    expect(pictureFileProblem({ type: "image/jpeg", size: 1000 })).toBeNull();
    expect(pictureFileProblem({ type: "application/pdf", size: 1000 })).toBe("notImage");
    expect(pictureFileProblem({ type: "", size: 1000 })).toBe("notImage");
    expect(pictureFileProblem({ type: "image/png", size: PICTURE_MAX_BYTES + 1 })).toBe("tooLarge");
    expect(pictureFileProblem({ type: "image/png", size: 0 })).toBe("unreadable");
  });

  it("refuses before decoding anything", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    try {
      await expect(readPicture(new Blob(["%PDF"], { type: "application/pdf" }))).rejects.toMatchObject({
        problem: "notImage",
      });
      const huge = { type: "image/jpeg", size: PICTURE_MAX_BYTES + 1 } as Blob;
      await expect(readPicture(huge)).rejects.toMatchObject({ problem: "tooLarge" });
      expect(decode).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("turns photos the way their camera meant, and refuses giant ones after decoding", async () => {
    const close = vi.fn();
    const decode = vi.fn(async () => ({ width: 10_000, height: 10_000, close }));
    vi.stubGlobal("createImageBitmap", decode);
    try {
      const file = new Blob(["jpeg"], { type: "image/jpeg" });
      await expect(readPicture(file)).rejects.toMatchObject({ problem: "tooLarge" });
      expect(decode).toHaveBeenCalledWith(file, { imageOrientation: "from-image" });
      expect(close).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a small file that claims a huge picture before decoding it (W-32)", async () => {
    const decode = vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() }));
    vi.stubGlobal("createImageBitmap", decode);
    try {
      const bomb = new Blob([png(20_000, 20_000)], { type: "image/png" });
      await expect(readPicture(bomb)).rejects.toMatchObject({ problem: "tooLarge" });
      // The claim is in the bytes, whatever the file calls itself.
      const renamed = new Blob([gif(10, 10, [[0, 0, 30_000, 30_000]])], { type: "image/jpeg" });
      await expect(readPicture(renamed)).rejects.toMatchObject({ problem: "tooLarge" });
      expect(decode).not.toHaveBeenCalled();
      await expect(readPicture(new Blob([png(640, 480)], { type: "image/png" }))).resolves.toMatchObject({
        width: 100,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("finds the picture among dropped files", () => {
    const text = new File(["a"], "a.txt", { type: "text/plain" });
    const photo = new File(["b"], "b.jpg", { type: "image/jpeg" });
    expect(firstPictureFile([text, photo])).toBe(photo);
    expect(firstPictureFile([text])).toBeNull();
    expect(firstPictureFile(null)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// Headers of the formats a browser decodes, as small as they come

const bytes = (...parts: (ArrayLike<number> | string)[]) =>
  new Uint8Array(
    parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : Array.from(part))),
  );
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [...le16(n & 0xffff), ...le16(n >>> 16)];
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [...be16(n >>> 16), ...be16(n & 0xffff)];

function png(width: number, height: number) {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    "IHDR",
    be32(width),
    be32(height),
    [8, 6, 0, 0, 0],
  );
}

/** A GIF with a logical screen and frames at [left, top, width, height], behind an extension. */
function gif(width: number, height: number, frames: number[][]) {
  return bytes(
    "GIF89a",
    le16(width),
    le16(height),
    [0x80, 0, 0], // a global colour table of two entries
    [0, 0, 0, 255, 255, 255],
    [0x21, 0xf9, 4, 0, 0, 0, 0, 0], // graphic control extension
    ...frames.flatMap(([left, top, w, h]) => [
      [0x2c],
      le16(left!),
      le16(top!),
      le16(w!),
      le16(h!),
      [0],
      [2, 2, 0x4c, 0x01, 0],
    ]),
    [0x3b],
  );
}

describe("the size a picture file claims", () => {
  it("is read from PNG, GIF, JPEG, WebP, BMP and icon headers", () => {
    expect(pictureDimensions(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(pictureDimensions(gif(16, 16, [[0, 0, 16, 16]]))).toEqual({ width: 16, height: 16 });
    // A frame that reaches past the logical screen makes it larger.
    expect(
      pictureDimensions(
        gif(16, 16, [
          [0, 0, 16, 16],
          [100, 5, 50_000, 20],
        ]),
      ),
    ).toEqual({
      width: 50_100,
      height: 25,
    });
    // EXIF and friends before the frame are skipped, fill bytes too.
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe1],
      be16(8),
      "Exif\0\0",
      [0xff, 0xff, 0xc2],
      be16(11),
      [8],
      be16(3000),
      be16(4000),
      [3],
    );
    expect(pictureDimensions(jpeg)).toEqual({ width: 4000, height: 3000 });
    expect(
      pictureDimensions(bytes("RIFF", le32(30), "WEBPVP8X", le32(10), [0, 0, 0, 0], le24(16_383), le24(9_999))),
    ).toEqual({
      width: 16_384,
      height: 10_000,
    });
    // VP8L packs 14 bits each: 1 + 0x3fff wide, 1 + 0x3fff high.
    expect(
      pictureDimensions(bytes("RIFF", le32(30), "WEBPVP8L", le32(10), [0x2f, 0xff, 0xff, 0xff, 0x0f], [0, 0, 0, 0])),
    ).toEqual({
      width: 16_384,
      height: 16_384,
    });
    expect(
      pictureDimensions(
        bytes("RIFF", le32(30), "WEBPVP8 ", le32(10), [0, 0, 0, 0x9d, 0x01, 0x2a], le16(320), le16(240)),
      ),
    ).toEqual({
      width: 320,
      height: 240,
    });
    expect(pictureDimensions(bytes("BM", new Array<number>(12).fill(0), le32(40), le32(800), le32(-600)))).toEqual({
      width: 800,
      height: 600,
    });
    // An icon of a small bitmap and a huge PNG: the PNG counts.
    const inner = png(40_000, 40_000);
    const dib = bytes(le32(40), le32(16), le32(32));
    const ico = bytes(
      [0, 0, 1, 0],
      le16(2),
      [16, 16, 0, 0],
      le16(1),
      le16(32),
      le32(dib.length),
      le32(38),
      [0, 0, 0, 0],
      le16(1),
      le16(32),
      le32(inner.length),
      le32(38 + dib.length),
      dib,
      inner,
    );
    expect(pictureDimensions(ico)).toEqual({ width: 40_000, height: 40_000 });
  });

  it("is unknown for anything else, and for broken headers", () => {
    expect(pictureDimensions(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(pictureDimensions(bytes([0xff, 0xd8], [0x12, 0x34]))).toBeNull();
    expect(pictureDimensions(bytes("GIF8"))).toBeNull();
    expect(pictureDimensions(new Uint8Array())).toBeNull();
  });

  it("is read in one pass, however the blocks are laid out", () => {
    // Fifty thousand empty extensions in a GIF, and a JPEG of nothing but fill bytes.
    const extensions = new Array<number>(50_000 * 3).fill(0).map((_, i) => [0x21, 0xfe, 0][i % 3]!);
    const start = performance.now();
    expect(pictureDimensions(bytes("GIF89a", le16(1), le16(1), [0, 0, 0], extensions, [0x3b]))).toEqual({
      width: 1,
      height: 1,
    });
    expect(pictureDimensions(bytes([0xff, 0xd8], new Array<number>(1_000_000).fill(0xff)))).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
