#!/usr/bin/env python3
"""
export_p2p.py — write Field Checkout data back into the original P2P workbook.

The original .xlsm is used as the template and is opened in place, so every
font, fill, border, number format, conditional-formatting rule, data
validation, merged range and the VBA macros survive untouched. Only the
sign-off cells are written.

    python3 export_p2p.py TEMPLATE.xlsm updates.json OUTPUT.xlsm

updates.json:
{
  "points": [
    {
      "unit": "AHU-1",
      "tag": "KOK_AHU_01_CLG_COIL_TEMP_A",
      "installed": "Cochran",        # Installed and Labeled
      "p2p":       "JH 9/19",        # Point To Point  (or "DNP" / "N/A")
      "trends":    "N/A",            # Trend/History
      "alarm":     "JH 9/19",
      "graphic":   "",               # "" leaves the cell alone
      "startup":   "",
      "notes":     "Valve stroking backwards"
    }
  ]
}

Rows are matched on (Unit Tag, Point Name), which is unique in this workbook.
A value of "" or null leaves the existing cell untouched; pass "__CLEAR__" to
blank a cell deliberately.
"""
import json
import sys
import unicodedata

import openpyxl

SHEET_CANDIDATES = ("Main P2PCO Sheet",)
CLEAR = "__CLEAR__"

# app field -> header text on the sheet
FIELD_HEADERS = {
    "installed": "installed and labeled",
    "p2p":       "point to point",
    "trends":    "trend/history",
    "alarm":     "alarm",
    "graphic":   "graphic",
    "startup":   "startup date",
    "notes":     "notes",
}


def norm(v):
    if v is None:
        return ""
    s = unicodedata.normalize("NFKD", str(v))
    return " ".join(s.split()).strip().lower()


def find_sheet(wb):
    for name in SHEET_CANDIDATES:
        if name in wb.sheetnames:
            return wb[name]
    for ws in wb.worksheets:                     # fall back to a header scan
        for r in range(1, min(ws.max_row, 30) + 1):
            row = [norm(ws.cell(r, c).value) for c in range(1, ws.max_column + 1)]
            if "point name" in row and "unit tag" in row:
                return ws
    raise SystemExit("No sheet with a 'Unit Tag' / 'Point Name' header row.")


def find_header_row(ws):
    for r in range(1, min(ws.max_row, 30) + 1):
        row = [norm(ws.cell(r, c).value) for c in range(1, ws.max_column + 1)]
        if "point name" in row and ("unit tag" in row or "type" in row):
            return r
    raise SystemExit("Could not locate the header row.")


def map_columns(ws, hdr_row):
    headers = {norm(ws.cell(hdr_row, c).value): c
               for c in range(1, ws.max_column + 1)}
    cols = {"unit": headers.get("unit tag"), "tag": headers.get("point name")}
    if not cols["tag"]:
        raise SystemExit("No 'Point Name' column.")
    for field, text in FIELD_HEADERS.items():
        cols[field] = headers.get(text)
        if cols[field] is None:                  # tolerate trailing spaces etc.
            for h, c in headers.items():
                if h.startswith(text):
                    cols[field] = c
                    break
    return cols


def index_rows(ws, cols, first_row):
    """(unit, tag) -> row number. Skips the Engineering/Electrician legend row."""
    idx = {}
    for r in range(first_row, ws.max_row + 1):
        tag = ws.cell(r, cols["tag"]).value
        if tag is None or not str(tag).strip():
            continue
        if norm(tag) in ("engineering", "electrician", "specialist"):
            continue
        unit = ws.cell(r, cols["unit"]).value if cols["unit"] else ""
        idx[(norm(unit), norm(tag))] = r
    return idx


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    template, updates_path, out_path = sys.argv[1:4]

    with open(updates_path) as fh:
        payload = json.load(fh)
    points = payload.get("points", [])

    wb = openpyxl.load_workbook(template, keep_vba=True)   # keeps macros
    ws = find_sheet(wb)
    hdr = find_header_row(ws)
    cols = map_columns(ws, hdr)
    idx = index_rows(ws, cols, hdr + 1)

    written = 0
    matched = 0
    missing = []

    for p in points:
        key = (norm(p.get("unit")), norm(p.get("tag")))
        row = idx.get(key)
        if row is None:
            missing.append(f'{p.get("unit")} / {p.get("tag")}')
            continue
        matched += 1
        for field in FIELD_HEADERS:
            col = cols.get(field)
            if not col:
                continue
            val = p.get(field)
            if val is None or val == "":
                continue                          # leave the cell as it is
            ws.cell(row, col).value = None if val == CLEAR else val
            written += 1

    wb.save(out_path)

    report = {
        "output": out_path,
        "sheet": ws.title,
        "header_row": hdr,
        "points_in_payload": len(points),
        "rows_matched": matched,
        "cells_written": written,
        "unmatched": missing[:25],
        "unmatched_count": len(missing),
    }
    print(json.dumps(report, indent=2))
    if missing:
        print(f"\nWARNING: {len(missing)} point(s) had no matching row.",
              file=sys.stderr)


if __name__ == "__main__":
    main()
