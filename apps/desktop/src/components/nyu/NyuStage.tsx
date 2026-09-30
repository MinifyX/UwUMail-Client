import { lazy, Suspense, useEffect } from "react";
import { useNyuCameo } from "./cameo";
import { useNyuLevel } from "./level";

const loadCameos = () => import("./Cameos");
const CameoView = lazy(loadCameos);

/**
 * Where Nyu's cameos appear: mount once near the root. Fixed in a corner, above the content and
 * below dialogs, never taking a click; the drawings load only when Nyu is allowed to move.
 */
export function NyuStage() {
  const cameo = useNyuCameo((s) => s.current);
  const level = useNyuLevel();

  // Fetched while the browser is idle, so the first cameo doesn't wait for its drawings.
  useEffect(() => {
    if (level === "off") return;
    const preload = () => void loadCameos().catch(() => undefined);
    if ("requestIdleCallback" in window) {
      const handle = window.requestIdleCallback(preload);
      return () => window.cancelIdleCallback(handle);
    }
    const timer = setTimeout(preload, 1500);
    return () => clearTimeout(timer);
  }, [level]);

  if (!cameo || level === "off") return null;
  return (
    <Suspense fallback={null}>
      <CameoView key={cameo.id} cameo={cameo} />
    </Suspense>
  );
}
