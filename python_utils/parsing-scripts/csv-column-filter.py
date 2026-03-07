"""
Standalone script to extract specific columns from filtered_output.csv.
Keeps only DGUID, GEO_NAME, and C1_COUNT_TOTAL.

Usage:
    python csv-column-filter.py [input_csv] [output_csv]

Defaults:
    input_csv  → filtered_output.csv  (in the same directory as this script)
    output_csv → sorted_output.csv    (in the same directory as this script)
"""

import csv
import os
import sys

COLUMNS_TO_KEEP = ["DGUID", "GEO_NAME", "C1_COUNT_TOTAL"]


def filter_columns(input_path: str, output_path: str) -> int:
    """
    Read *input_path*, write only COLUMNS_TO_KEEP to *output_path*.
    Returns the number of data rows written.
    """
    rows_written = 0

    with open(input_path, newline="", encoding="latin-1") as infile:
        reader = csv.DictReader(infile)

        # Validate that the expected columns exist
        missing = [col for col in COLUMNS_TO_KEEP if col not in reader.fieldnames]
        if missing:
            print(f"Error: Missing column(s) in input CSV: {missing}")
            sys.exit(1)

        with open(output_path, "w", newline="", encoding="utf-8") as outfile:
            writer = csv.DictWriter(outfile, fieldnames=COLUMNS_TO_KEEP)
            writer.writeheader()

            for row in reader:
                writer.writerow({col: row[col] for col in COLUMNS_TO_KEEP})
                rows_written += 1

    return rows_written


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))

    input_path = sys.argv[1] if len(sys.argv) >= 2 else os.path.join(script_dir, "filtered_output.csv")
    output_path = sys.argv[2] if len(sys.argv) >= 3 else os.path.join(script_dir, "sorted_output.csv")

    if not os.path.isfile(input_path):
        print(f"Error: '{input_path}' not found.")
        sys.exit(1)

    count = filter_columns(input_path, output_path)
    print(f"Done — {count} row(s) with columns {COLUMNS_TO_KEEP} written to '{output_path}'.")


if __name__ == "__main__":
    main()
