// Runs `recolorPixels` away from the page, so large images never make the app stutter.

import { recolorPixels, type RecolorDone, type RecolorJob } from "./imageRecolor";

self.onmessage = ({ data }: MessageEvent<RecolorJob>) => {
  const pixels = new Uint8ClampedArray(data.buffer);
  const verdict = recolorPixels(pixels, data.width, data.height, data.paper);
  const done: RecolorDone = { id: data.id, verdict, buffer: data.buffer };
  (self as unknown as Worker).postMessage(done, [data.buffer]);
};
