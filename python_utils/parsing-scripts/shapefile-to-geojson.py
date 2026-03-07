"""
Standalone script to filter a Statistics Canada census subdivision shapefile
by province (PRUID) and convert the result to GeoJSON.

Usage:
    python shapefile-to-geojson.py <input_shapefile> [output_geojson] [--pruid PRUID]

Examples:
    # Filter Ontario (PRUID 35) — the default
    python shapefile-to-geojson.py lda_000b21a_e/lda_000b21a_e.shp

    # Filter Quebec (PRUID 24)
    python shapefile-to-geojson.py lda_000b21a_e/lda_000b21a_e.shp --pruid 24

    # Custom output path
    python shapefile-to-geojson.py lda_000b21a_e/lda_000b21a_e.shp ontario.geojson
"""

import argparse
import os
import sys
import geopandas as gpd


def filter_and_convert(input_path: str, output_path: str, pruid: str) -> int:
    """
    Read *input_path* shapefile, keep only features where PRUID == *pruid*,
    reproject to WGS 84 (EPSG:4326), and write to *output_path* as GeoJSON.

    Returns the number of features written.
    """
    print(f"Reading shapefile: {input_path}")
    gdf = gpd.read_file(input_path)

    print(f"  Total features: {len(gdf)}")
    filtered = gdf[gdf["PRUID"] == pruid].copy()
    print(f"  Features with PRUID={pruid}: {len(filtered)}")

    if filtered.empty:
        print(f"Warning: No features found with PRUID={pruid}.")
        return 0

    # Reproject to WGS 84 (standard for GeoJSON)
    if filtered.crs and filtered.crs.to_epsg() != 4326:
        print(f"  Reprojecting from {filtered.crs} to EPSG:4326 (WGS 84)...")
        filtered = filtered.to_crs(epsg=4326)

    print(f"  Writing GeoJSON: {output_path}")
    filtered.to_file(output_path, driver="GeoJSON")

    return len(filtered)


def main():
    parser = argparse.ArgumentParser(
        description="Filter a shapefile by PRUID and convert to GeoJSON."
    )
    parser.add_argument("input", help="Path to the input shapefile (.shp)")
    parser.add_argument(
        "output",
        nargs="?",
        default=None,
        help="Path for the output GeoJSON file (default: filtered_<pruid>.geojson)",
    )
    parser.add_argument(
        "--pruid",
        default="35",
        help="PRUID to filter by (default: 35 for Ontario)",
    )

    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"Error: '{args.input}' not found.")
        sys.exit(1)

    output_path = args.output
    if output_path is None:
        input_dir = os.path.dirname(os.path.abspath(args.input))
        output_path = os.path.join(input_dir, f"filtered_{args.pruid}.geojson")

    count = filter_and_convert(args.input, output_path, args.pruid)
    print(f"Done — {count} feature(s) written to '{output_path}'.")


if __name__ == "__main__":
    main()
