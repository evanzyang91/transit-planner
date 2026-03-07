"""
Standalone script to upload population boundary data from CSV to Supabase 'pop_data'.

Maps specific fields from 2021_92-151_X_filtered.csv to Supabase columns.
Assumes the 'pop_data' table has the following columns:
    - block_id   (TEXT, Primary Key)
    - latitude   (DOUBLE PRECISION)
    - longitude  (DOUBLE PRECISION)
    - population (INTEGER)
    - area       (DOUBLE PRECISION)
    - dwelling   (INTEGER)
    - name       (TEXT)

Usage:
    python upload_pop_data.py [input_csv]
"""

import csv
import os
import sys

from dotenv import load_dotenv
from supabase import create_client, Client

# ── Configuration ────────────────────────────────────────────────────
TABLE_NAME = "pop_data"
BATCH_SIZE = 1000

# Mapping: CSV Column Name -> Supabase Column Name
COLUMN_MAPPING = {
    "DBUID_IDIDU": "block_id",
    "DARPLAT_ADLAT": "latitude",
    "DARPLONG_ADLONG": "longitude",
    "DBPOP2021_IDPOP2021": "population",
    "DBAREA2021_IDSUP2021": "area",
    "DBURDWELL2021_IDRHLOG2021": "dwelling",
    "FEDNAME_CEFNOM": "name",
}


def load_env() -> tuple[str, str]:
    """Load and validate Supabase credentials from .env."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    load_dotenv(os.path.join(project_root, ".env"))

    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_KEY", "")

    if not url or not key:
        print("Error: SUPABASE_URL and SUPABASE_KEY must be set in .env")
        sys.exit(1)

    return url, key


def parse_numeric(val: str, expected_type: type):
    """
    Parses a string safely to int or float.
    Returns None if the string is empty or invalid.
    """
    val = val.strip()
    if not val:
        return None
    try:
        return expected_type(val)
    except ValueError:
        return None


def extract_rows(csv_path: str) -> list[dict]:
    """Read CSV and transform rows to match the Supabase schema."""
    rows = []
    
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        
        if reader.fieldnames is None:
            print(f"Error: {csv_path} is empty or has no header.")
            sys.exit(1)
            
        # Verify required columns exist
        missing = [col for col in COLUMN_MAPPING.keys() if col not in reader.fieldnames]
        if missing:
            print(f"Error: Missing expected columns in CSV: {missing}")
            sys.exit(1)

        for row in reader:
            block_id = row["DBUID_IDIDU"].strip()
            if not block_id:
                continue

            parsed_row = {
                "block_id": block_id,
                "latitude": parse_numeric(row["DARPLAT_ADLAT"], float),
                "longitude": parse_numeric(row["DARPLONG_ADLONG"], float),
                "population": parse_numeric(row["DBPOP2021_IDPOP2021"], int),
                "area": parse_numeric(row["DBAREA2021_IDSUP2021"], float),
                "dwelling": parse_numeric(row["DBURDWELL2021_IDRHLOG2021"], int),
                "name": row["FEDNAME_CEFNOM"].strip(),
            }
            rows.append(parsed_row)

    return rows


def upload_rows(supabase: Client, rows: list[dict]) -> int:
    """Upsert rows in batches."""
    total = len(rows)

    for i in range(0, total, BATCH_SIZE):
        batch = rows[i : i + BATCH_SIZE]
        supabase.table(TABLE_NAME).upsert(batch).execute()
        end = min(i + BATCH_SIZE, total)
        print(f"  Upserted rows {i + 1}–{end} of {total}")

    return total


def main() -> None:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    if len(sys.argv) >= 2:
        csv_path = sys.argv[1]
    else:
        # Default to the recently filtered file
        csv_path = os.path.join(script_dir, "2021_92-151_X_filtered.csv")

    if not os.path.isfile(csv_path):
        print(f"Error: '{csv_path}' not found.")
        sys.exit(1)

    url, key = load_env()
    print("Connecting to Supabase...")
    supabase = create_client(url, key)

    print(f"Reading CSV: {csv_path}")
    rows = extract_rows(csv_path)
    print(f"Extracted {len(rows)} valid records.")
    
    if not rows:
        print("No valid rows to upload.")
        sys.exit(0)

    print(f"Uploading to table '{TABLE_NAME}'...")
    total = upload_rows(supabase, rows)
    print(f"Done — {total} row(s) uploaded successfully.")


if __name__ == "__main__":
    main()
