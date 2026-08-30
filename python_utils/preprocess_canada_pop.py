#!/usr/bin/env python3
"""
Preprocess can_pd_2020_1km_UNadj_ASCII_XYZ.csv into a compact binary.

Output: can_pop.bin
Format: header (4 bytes uint32 = N points) + N * 12 bytes (float32 lng, float32 lat, float32 density)

Run from repo root:
  python python_utils/preprocess_canada_pop.py
"""

import struct
import sys
import os

INPUT = "can_pd_2020_1km_UNadj_ASCII_XYZ.csv"
OUTPUT = "web/public/can_pop.bin"

MIN_DENSITY = 1.0   # people/km² — below this we skip (eliminates ~85% of rows)
MAX_DENSITY = 1e6   # cap extreme outliers

os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)

print(f"Reading {INPUT}...")
points = []
skipped = 0
total = 0

with open(INPUT, "r") as f:
    next(f)  # skip header
    for line in f:
        total += 1
        if total % 2_000_000 == 0:
            print(f"  {total:,} rows read, {len(points):,} kept...")
        try:
            parts = line.split(",")
            lng = float(parts[0])
            lat = float(parts[1])
            z   = float(parts[2])
        except (ValueError, IndexError):
            skipped += 1
            continue

        if z < MIN_DENSITY:
            skipped += 1
            continue

        # Cap to Canada's populated bounding box (excludes far Arctic)
        if lat > 84 or lat < 41 or lng < -141 or lng > -52:
            skipped += 1
            continue

        density = min(z, MAX_DENSITY)
        points.append((lng, lat, density))

print(f"Done reading. {len(points):,} points kept out of {total:,} ({skipped:,} skipped).")
print(f"Writing {OUTPUT}...")

with open(OUTPUT, "wb") as f:
    f.write(struct.pack("<I", len(points)))  # uint32 count
    for lng, lat, d in points:
        f.write(struct.pack("<fff", lng, lat, d))

size_mb = os.path.getsize(OUTPUT) / 1_048_576
print(f"Written: {OUTPUT} ({size_mb:.1f} MB, {len(points):,} points)")
