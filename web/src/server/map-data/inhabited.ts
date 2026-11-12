import "server-only";

/**
 * "Is this a place people live?" — raster-grounded, replacing the old
 * <8-km-from-a-population-centre heuristic (which passed for spots well out
 * in the lake near downtown). Census blocks only exist where people live, so
 * zero population within 1 km ⇒ water / empty land.
 *
 * Lives in its own module (moved verbatim from tools.ts) because both the
 * original drawing tools (tools.ts) and the new app actions (tools-actions.ts,
 * e.g. propose_line's stop check) need it — sharing it from here avoids an
 * import cycle between those two files.
 */

import { getTorontoRaster } from "./census";

/** true = inhabited, false = water / empty land, null = census data unavailable (don't hard-fail). */
export async function isInhabited(point: [number, number]): Promise<boolean | null> {
  const raster = await getTorontoRaster();
  if (!raster) return null; // unknown — callers should not hard-fail on this
  return raster.grid.within(point, 1.0).some((b) => b.population > 0);
}
