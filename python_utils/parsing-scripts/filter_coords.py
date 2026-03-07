"""
Standalone script to filter a CSV file by coordinate bounds.

Filters rows where:
    - 43.60 <= DARPLAT_ADLAT (Latitude) <= 43.85
    - -79.60 <= DARPLONG_ADLONG (Longitude) <= -79.10

Usage:
    python filter_coords.py [input_csv] [output_csv]
"""

import csv
import os
import sys

# ── Configuration ────────────────────────────────────────────────────
LAT_COL = "DARPLAT_ADLAT"
LON_COL = "DARPLONG_ADLONG"

LAT_MIN, LAT_MAX = 43.60, 43.85
LON_MIN, LON_MAX = -79.60, -79.10


def filter_csv_by_bounds(input_path: str, output_path: str) -> tuple[int, int]:
    """
    Reads input CSV, filters by coordinate bounds, and writes to output CSV.
    Returns (total_rows_read, rows_written).
    """
    rows_written = 0
    total_rows = 0

    # Using latin-1 encoding to match Statistics Canada typical CSV format
    with open(input_path, newline="", encoding="latin-1") as infile:
        reader = csv.DictReader(infile)
        
        if reader.fieldnames is None:
            print("Error: Input CSV is empty.")
            sys.exit(1)
            
        if LAT_COL not in reader.fieldnames or LON_COL not in reader.fieldnames:
            print(f"Error: Missing coordinate columns. Required: {LAT_COL}, {LON_COL}")
            print(f"Found columns: {reader.fieldnames}")
            sys.exit(1)

        with open(output_path, "w", newline="", encoding="utf-8") as outfile:
            writer = csv.DictWriter(outfile, fieldnames=reader.fieldnames)
            writer.writeheader()

            for row in reader:
                total_rows += 1
                try:
                    lat_str = row[LAT_COL].strip()
                    lon_str = row[LON_COL].strip()
                    
                    if not lat_str or not lon_str:
                        continue
                        
                    lat = float(lat_str)
                    lon = float(lon_str)

                    if (LAT_MIN <= lat <= LAT_MAX) and (LON_MIN <= lon <= LON_MAX):
                        writer.writerow(row)
                        rows_written += 1
                except ValueError:
                    # Skip rows with malformed coordinates
                    continue

    return total_rows, rows_written


def main() -> None:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    if len(sys.argv) >= 2:
        input_path = sys.argv[1]
    else:
        # Default fallback, though user will likely pass the specific CSV
        print("Please provide the input CSV path.")
        print(f"Usage: python {os.path.basename(__file__)} <input_csv> [output_csv]")
        sys.exit(1)

    if not os.path.isfile(input_path):
        print(f"Error: '{input_path}' not found.")
        sys.exit(1)

    if len(sys.argv) >= 3:
        output_path = sys.argv[2]
    else:
        input_dir = os.path.dirname(os.path.abspath(input_path))
        base_name = os.path.basename(input_path)
        name, ext = os.path.splitext(base_name)
        output_path = os.path.join(input_dir, f"{name}_gta_filtered{ext}")

    print(f"Filtering {input_path}...")
    print(f"Bounds: Lat[{LAT_MIN} to {LAT_MAX}], Lon[{LON_MIN} to {LON_MAX}]")
    
    total, written = filter_csv_by_bounds(input_path, output_path)
    
    print(f"Done!")
    print(f"Read: {total} rows")
    print(f"Kept: {written} rows")
    print(f"Output saved to: {output_path}")


if __name__ == "__main__":
    main()
