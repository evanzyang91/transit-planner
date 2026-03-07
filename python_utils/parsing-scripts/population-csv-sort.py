"""
Standalone script to filter a population CSV file.
Keeps only rows containing "Total - Age groups of the population - 100% data".

Usage:
    python population-csv-sort.py <input_csv> [output_csv]

If no output file is specified, defaults to 'filtered_output.csv' in the
same directory as the input file.
"""

import csv
import sys
import os

FILTER_VALUE = "Total - Age groups of the population - 100% data"


def filter_csv(input_path: str, output_path: str) -> int:
    """
    Read *input_path*, write only the header and rows that contain
    FILTER_VALUE in any cell to *output_path*.

    Returns the number of matching rows written (excluding the header).
    """
    matched = 0

    with open(input_path, newline="", encoding="latin-1") as infile:
        reader = csv.reader(infile)
        header = next(reader, None)

        if header is None:
            print("Error: The input CSV file is empty.")
            sys.exit(1)

        with open(output_path, "w", newline="", encoding="utf-8") as outfile:
            writer = csv.writer(outfile)
            writer.writerow(header)

            for row in reader:
                if FILTER_VALUE in row:
                    writer.writerow(row)
                    matched += 1

    return matched


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip())
        sys.exit(1)

    input_path = sys.argv[1]

    if not os.path.isfile(input_path):
        print(f"Error: '{input_path}' not found.")
        sys.exit(1)

    if len(sys.argv) >= 3:
        output_path = sys.argv[2]
    else:
        input_dir = os.path.dirname(os.path.abspath(input_path))
        output_path = os.path.join(input_dir, "filtered_output.csv")

    matched = filter_csv(input_path, output_path)
    print(f"Done — {matched} matching row(s) written to '{output_path}'.")


if __name__ == "__main__":
    main()
