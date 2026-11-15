import { lazy, Suspense } from "react";

// The parcels load when they are first opened, so the mail starts no slower for them.
const ShipmentsView = lazy(() =>
  import("../shipments/ShipmentsView").then((module) => ({ default: module.ShipmentsView })),
);

/** The parcels in place of the mail (see ShipmentsView). */
export function LazyShipments() {
  return (
    <Suspense fallback={null}>
      <ShipmentsView />
    </Suspense>
  );
}
