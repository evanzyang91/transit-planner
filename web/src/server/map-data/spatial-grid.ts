import "server-only";

/**
 * Spatial hash grid for fast nearest-neighbour / radius queries.
 *
 * Why: the gap engine asks "how far is the nearest stop?" for every census
 * block. Brute force is O(blocks × stops) ≈ 10⁸ haversines per request with
 * bus routes included — far too slow. Bucketing points into ~cell-sized bins
 * makes each lookup touch only a handful of nearby bins.
 *
 * 📖 Learn: spatial hashing — quantise coordinates to integer cell indices and
 * store points in a Map keyed by cell. A radius query only inspects the cells
 * a circle of that radius can overlap; a nearest query searches outward ring
 * by ring until the best exact distance can't be beaten by a farther ring.
 */

import { haversineKm } from "~/app/map/geo-utils";
import { KM_PER_DEG_LAT, KM_PER_DEG_LNG } from "./geo";

export interface GridPoint {
  coords: [number, number]; // [lng, lat]
}

export class SpatialGrid<T extends GridPoint> {
  private cells = new Map<string, T[]>();
  private readonly cellKm: number;
  readonly size: number;

  constructor(points: T[], cellKm = 1) {
    this.cellKm = cellKm;
    this.size = points.length;
    for (const p of points) {
      const key = this.key(p.coords);
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(p);
      else this.cells.set(key, [p]);
    }
  }

  private cellIndex([lng, lat]: [number, number]): [number, number] {
    return [
      Math.floor((lng * KM_PER_DEG_LNG) / this.cellKm),
      Math.floor((lat * KM_PER_DEG_LAT) / this.cellKm),
    ];
  }

  private key(coords: [number, number]): string {
    const [ix, iy] = this.cellIndex(coords);
    return `${ix}:${iy}`;
  }

  /** All points within `radiusKm` of `point` (exact circular test). */
  within(point: [number, number], radiusKm: number): T[] {
    const [cx, cy] = this.cellIndex(point);
    const reach = Math.ceil(radiusKm / this.cellKm);
    const out: T[] = [];
    for (let ix = cx - reach; ix <= cx + reach; ix++) {
      for (let iy = cy - reach; iy <= cy + reach; iy++) {
        const bucket = this.cells.get(`${ix}:${iy}`);
        if (!bucket) continue;
        for (const p of bucket) {
          if (haversineKm(point, p.coords) <= radiusKm) out.push(p);
        }
      }
    }
    return out;
  }

  /**
   * Nearest point to `point`, searching at most `maxKm` out.
   * Returns null if nothing lies within `maxKm`.
   */
  nearest(point: [number, number], maxKm = 10): { item: T; km: number } | null {
    const [cx, cy] = this.cellIndex(point);
    const maxRings = Math.ceil(maxKm / this.cellKm) + 1;
    let best: { item: T; km: number } | null = null;

    for (let ring = 0; ring <= maxRings; ring++) {
      // Once we have a hit, any point in a farther ring is at least
      // (ring - 1) * cellKm away — stop when that can't beat the best.
      if (best && (ring - 1) * this.cellKm > best.km) break;

      for (let ix = cx - ring; ix <= cx + ring; ix++) {
        for (let iy = cy - ring; iy <= cy + ring; iy++) {
          // Only the ring's perimeter — inner cells were covered already.
          if (ring > 0 && Math.abs(ix - cx) !== ring && Math.abs(iy - cy) !== ring) continue;
          const bucket = this.cells.get(`${ix}:${iy}`);
          if (!bucket) continue;
          for (const p of bucket) {
            const km = haversineKm(point, p.coords);
            if (km <= maxKm && (!best || km < best.km)) best = { item: p, km };
          }
        }
      }
    }
    return best;
  }
}
