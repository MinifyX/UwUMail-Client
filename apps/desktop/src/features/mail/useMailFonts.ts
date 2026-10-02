import { useEffect, useMemo, useState } from "react";
import { loadMailFont, mailFontFaces } from "@/lib/fonts";
import { useSettings } from "@/state/settings";
import type { MailFonts } from "./MessageBody";

/** The chosen font for mail frames, loading its `data:` file on first use. */
export function useMailFonts(): MailFonts {
  const font = useSettings((s) => s.font);
  const senderFonts = useSettings((s) => s.senderFonts);
  const [, loaded] = useState(0);
  const faces = mailFontFaces(font);
  useEffect(() => {
    if (faces !== null) return;
    let live = true;
    loadMailFont(font).then(
      () => live && loaded((count) => count + 1),
      () => undefined, // the system font stays
    );
    return () => {
      live = false;
    };
  }, [font, faces]);
  return useMemo(() => ({ font, senderFonts, faces: faces ?? "" }), [font, senderFonts, faces]);
}
