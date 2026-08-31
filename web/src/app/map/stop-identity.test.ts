import { describe, expect, it } from "vitest";

import {
  isSameStation,
  newStopId,
  TRANSFER_RADIUS_KM,
  transferCounterparts,
  transferExclusionKey,
  withPositionalStopIds,
  withStopIds,
} from "./stop-identity";
import { BUS_ROUTES, ROUTES } from "./transit-data";

/**
 * Stop identity is the churn hotspot in this repo: six of the seven most recent
 * commits touch it ("false transfer detection", "stamp stable stop ids",
 * "address stops by id and require co-location"). The bugs it documents are the
 * cases pinned here — a shared name matching a GO station 13.9 km away, and one
 * route legitimately carrying the same stop name twice.
 */

type S = { id?: string; name: string; coords: [number, number] };
const stop = (name: string, coords: [number, number], id?: string): S => ({ name, coords, id });

// 50 m of latitude in degrees — TRANSFER_RADIUS_KM expressed as an offset.
const FIFTY_M_LAT = TRANSFER_RADIUS_KM / 110.574;

describe("isSameStation", () => {
  const base = stop("Eglinton", [-79.3986, 43.7052]);

  it("matches a same-named stop at the same coordinates", () => {
    expect(isSameStation(base, stop("Eglinton", [-79.3986, 43.7052]))).toBe(true);
  });

  it("matches a same-named stop just inside the transfer radius", () => {
    const near = stop("Eglinton", [-79.3986, 43.7052 + FIFTY_M_LAT * 0.8]);
    expect(isSameStation(base, near)).toBe(true);
  });

  it("rejects a same-named stop well outside the radius (the Eglinton/GO bug)", () => {
    // The documented false positive: "Eglinton" on Line 1 vs a GO station
    // 13.9 km away. Name equality alone produced 853 of these.
    const farGoStation = stop("Eglinton", [-79.3986, 43.7052 + 13.9 / 110.574]);
    expect(isSameStation(base, farGoStation)).toBe(false);
  });

  it("rejects co-located stops with different names", () => {
    expect(isSameStation(base, stop("Davisville", [-79.3986, 43.7052]))).toBe(false);
  });

  it("is symmetric", () => {
    const other = stop("Eglinton", [-79.3986, 43.7052 + FIFTY_M_LAT * 0.5]);
    expect(isSameStation(base, other)).toBe(isSameStation(other, base));
  });
});

describe("withPositionalStopIds", () => {
  const routes = [
    { id: "line-1", stops: [stop("A", [-79.4, 43.7]), stop("B", [-79.41, 43.71])] },
  ];

  it("assigns <routeId>-s<index> ids", () => {
    const [route] = withPositionalStopIds(routes);
    expect(route!.stops.map((s) => s.id)).toEqual(["line-1-s0", "line-1-s1"]);
  });

  it("is deterministic across calls — ids in saved plans stay meaningful", () => {
    expect(withPositionalStopIds(routes)[0]!.stops.map((s) => s.id)).toEqual(
      withPositionalStopIds(routes)[0]!.stops.map((s) => s.id),
    );
  });

  it("preserves ids that already exist", () => {
    const withId = [{ id: "line-1", stops: [stop("A", [-79.4, 43.7], "custom-id")] }];
    expect(withPositionalStopIds(withId)[0]!.stops[0]!.id).toBe("custom-id");
  });

  it("does not mutate its input", () => {
    const input = [{ id: "line-1", stops: [stop("A", [-79.4, 43.7])] }];
    withPositionalStopIds(input);
    expect(input[0]!.stops[0]!.id).toBeUndefined();
  });

  it("gives distinct ids to duplicate names on one route (the bus-132 case)", () => {
    // bus-132 carries "715 Milner Ave" twice, 282 m apart. Name is not a key.
    const dup = [
      {
        id: "bus-132",
        stops: [
          stop("715 Milner Ave", [-79.22, 43.79]),
          stop("715 Milner Ave", [-79.2225, 43.7915]),
        ],
      },
    ];
    const ids = withPositionalStopIds(dup)[0]!.stops.map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("withStopIds", () => {
  it("backfills ids for stops arriving without them", () => {
    const out = withStopIds([{ id: "r", stops: [stop("A", [-79.4, 43.7])] }]);
    expect(out[0]!.stops[0]!.id).toBeTruthy();
  });

  it("is idempotent — re-running keeps existing ids", () => {
    const once = withStopIds([{ id: "r", stops: [stop("A", [-79.4, 43.7])] }]);
    expect(withStopIds(once)[0]!.stops[0]!.id).toBe(once[0]!.stops[0]!.id);
  });
});

describe("newStopId", () => {
  it("produces unique ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newStopId()));
    expect(ids.size).toBe(500);
  });
});

describe("transferExclusionKey", () => {
  it("is order-independent, so dismissing from either side hides the link", () => {
    expect(transferExclusionKey("a", "b", "Union")).toBe(transferExclusionKey("b", "a", "Union"));
  });

  it("distinguishes different stop names on the same route pair", () => {
    expect(transferExclusionKey("a", "b", "Union")).not.toBe(
      transferExclusionKey("a", "b", "Bloor"),
    );
  });
});

describe("transferCounterparts", () => {
  const shared = stop("Union", [-79.3806, 43.6453]);
  const routes = [
    { id: "line-1", stops: [shared] },
    { id: "line-2", stops: [stop("Union", [-79.3806, 43.6453])] },
    { id: "line-3", stops: [stop("Union", [-79.3806, 43.9])] }, // same name, 28 km away
    { id: "line-4", stops: [stop("Spadina", [-79.3806, 43.6453])] }, // co-located, other name
  ];

  it("finds only genuinely co-located same-name stops", () => {
    const out = transferCounterparts(routes, "line-1", shared);
    expect(out.map((c) => c.route.id)).toEqual(["line-2"]);
  });

  it("never returns the source route itself", () => {
    const out = transferCounterparts(routes, "line-1", shared);
    expect(out.some((c) => c.route.id === "line-1")).toBe(false);
  });

  it("honours the exclusion predicate", () => {
    const out = transferCounterparts(routes, "line-1", shared, (id) => id === "line-2");
    expect(out).toHaveLength(0);
  });
});

describe("real built-in network", () => {
  const all = [...ROUTES, ...BUS_ROUTES];

  it("gives every stop in the shipped data an id", () => {
    const missing = all.flatMap((r) => r.stops.filter((s) => !s.id).map(() => r.id));
    expect(missing).toEqual([]);
  });

  it("keeps stop ids unique within each route", () => {
    for (const route of all) {
      const ids = route.stops.map((s) => s.id);
      expect(new Set(ids).size, `duplicate stop ids on ${route.id}`).toBe(ids.length);
    }
  });

  it("reports no transfer between stops further apart than the radius", () => {
    // The invariant behind "853 false transfers": every pair the app calls a
    // transfer must actually be co-located. Sampled for runtime, not sampled
    // for leniency — any single violation fails.
    const haversineKm = (a: [number, number], b: [number, number]) => {
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(b[1] - a[1]);
      const dLon = toRad(b[0] - a[0]);
      const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
      return 6371 * 2 * Math.asin(Math.sqrt(x));
    };

    for (const route of ROUTES) {
      for (const s of route.stops) {
        for (const c of transferCounterparts(all, route.id, s)) {
          expect(
            haversineKm(s.coords, c.stop.coords),
            `${route.id}/${s.name} -> ${c.route.id}/${c.stop.name}`,
          ).toBeLessThanOrEqual(TRANSFER_RADIUS_KM);
        }
      }
    }
  });
});
