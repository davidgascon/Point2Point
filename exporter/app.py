"""
Field Checkout — export service.

Writes verification data back into a project's original P2P workbook.
The workbook is opened in place and only the sign-off cells are written, so
every font, fill, border, conditional-formatting rule, data validation,
merged range and the VBA macros survive untouched. A browser cannot do this;
the JavaScript spreadsheet libraries drop cell styling on write.

Endpoints
    GET  /export/health
    POST /export/template/{project_id}   multipart file=<original .xlsm>
    GET  /export/template/{project_id}   does a template exist?
    POST /export/p2p/{project_id}        json body -> .xlsm download

Every request must carry the caller's PocketBase token as
`Authorization: Bearer <token>`; the service verifies it against PocketBase
and checks the caller is a member of the project before touching anything.
"""
from __future__ import annotations

import io
import os
import re
import unicodedata
from pathlib import Path

import httpx
from copy import copy

import openpyxl
from openpyxl.comments import Comment
from openpyxl.formatting.formatting import ConditionalFormattingList
from openpyxl.worksheet.cell_range import MultiCellRange
from fastapi import Depends, FastAPI, Header, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

PB = os.environ.get("PB_INTERNAL_URL", "http://pocketbase:8090")
TEMPLATES = Path("/templates")
TEMPLATES.mkdir(parents=True, exist_ok=True)

XLSM_MIME = "application/vnd.ms-excel.sheet.macroEnabled.12"
CLEAR = "__CLEAR__"

FIELD_HEADERS = {
    "installed": "installed and labeled",
    "p2p": "point to point",
    "trends": "trend/history",
    "alarm": "alarm",
    "graphic": "graphic",
    "startup": "startup date",
    "notes": "notes",
}

app = FastAPI(title="Field Checkout export", docs_url=None, redoc_url=None)


# --------------------------------------------------------------------- auth
async def caller(authorization: str = Header(default="")) -> dict:
    """Verify the bearer token with PocketBase and return the user record."""
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization.split(None, 1)[1]
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(
            f"{PB}/api/collections/users/auth-refresh",
            headers={"Authorization": f"Bearer {token}"},
        )
    if r.status_code != 200:
        raise HTTPException(401, "Not signed in")
    data = r.json()
    return {"token": token, "user": data.get("record", {})}


async def require_member(project_id: str, who: dict) -> None:
    """Membership is checked against PocketBase using the caller's own token,
    so its API rules — not this service — remain the source of truth."""
    if who["user"].get("role") == "admin":
        return
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(
            f"{PB}/api/collections/project_members/records",
            params={
                "filter": f'project="{project_id}" && user="{who["user"]["id"]}"',
                "perPage": 1,
            },
            headers={"Authorization": f'Bearer {who["token"]}'},
        )
    if r.status_code != 200 or not r.json().get("items"):
        raise HTTPException(403, "Not a member of this project")


# ------------------------------------------------------------------ helpers
def norm(v) -> str:
    if v is None:
        return ""
    return " ".join(unicodedata.normalize("NFKD", str(v)).split()).strip().lower()


def safe_id(pid: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", pid):
        raise HTTPException(400, "Bad project id")
    return pid


def template_path(pid: str) -> Path:
    return TEMPLATES / f"{safe_id(pid)}.xlsm"


def find_sheet(wb):
    if "Main P2PCO Sheet" in wb.sheetnames:
        return wb["Main P2PCO Sheet"]
    for ws in wb.worksheets:
        for r in range(1, min(ws.max_row, 30) + 1):
            row = [norm(ws.cell(r, c).value) for c in range(1, ws.max_column + 1)]
            if "point name" in row and "unit tag" in row:
                return ws
    raise HTTPException(422, "No sheet with a Unit Tag / Point Name header row")


def header_row(ws) -> int:
    for r in range(1, min(ws.max_row, 30) + 1):
        row = [norm(ws.cell(r, c).value) for c in range(1, ws.max_column + 1)]
        if "point name" in row and ("unit tag" in row or "type" in row):
            return r
    raise HTTPException(422, "Could not locate the header row")


def map_columns(ws, hdr: int) -> dict:
    headers = {norm(ws.cell(hdr, c).value): c for c in range(1, ws.max_column + 1)}
    cols = {"unit": headers.get("unit tag"), "tag": headers.get("point name")}
    if not cols["tag"]:
        raise HTTPException(422, "No Point Name column")
    for field, text in FIELD_HEADERS.items():
        col = headers.get(text)
        if col is None:
            for h, c in headers.items():
                if h.startswith(text):
                    col = c
                    break
        cols[field] = col
    return cols


# ───────────────── inserting field-added points into the main sheet ──────────

def _shift(lo, hi, at, n=1, extend_adjacent=False):
    """How a row range moves when n rows are inserted at `at`.

    extend_adjacent grows a block ending immediately above the insertion —
    right for a formatting band, wrong for a formula, where G59:L59 means
    "this row" and stretching it to G59:L60 silently averages in a neighbour."""
    if lo >= at:
        return lo + n, hi + n
    if hi >= at:
        return lo, hi + n
    if extend_adjacent and hi == at - 1:
        return lo, hi + n
    return lo, hi


def _shift_sqref(sqref, at, n=1):
    out = []
    for part in str(sqref).split():
        m = re.match(r"^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$", part)
        if not m:
            out.append(part)
            continue
        c1, r1, c2, r2 = m.group(1), int(m.group(2)), m.group(3), m.group(4)
        if c2 is None:
            r1b, _ = _shift(r1, r1, at, n, extend_adjacent=True)
            out.append(f"{c1}{r1b}")
        else:
            r1b, r2b = _shift(r1, int(r2), at, n, extend_adjacent=True)
            out.append(f"{c1}{r1b}:{c2}{r2b}")
    return " ".join(out)


def _shift_formula(f, at, n=1):
    def fix(m):
        col1, r1, col2, r2 = m.group(1), int(m.group(2)), m.group(3), int(m.group(4))
        a, b = _shift(r1, r2, at, n)
        return f"{col1}{a}:{col2}{b}"
    return re.sub(r"(\$?[A-Z]{1,3})(\d+):(\$?[A-Z]{1,3})(\d+)", fix, f)


def insert_row_like(ws, at, model_row, ncols):
    """Insert a row that inherits its neighbour's look, dragging the
    conditional formatting, validation and formulas with it. openpyxl shifts
    cell values on insert and nothing else, so without this the colour bands
    end one row short and the added point is the row that never formats."""
    ws.insert_rows(at)
    src_row = model_row if model_row < at else model_row + 1
    for c in range(1, ncols + 1):
        s, d = ws.cell(src_row, c), ws.cell(at, c)
        if s.has_style:
            d._style = copy(s._style)

    rules = [(str(rng.sqref), list(rs))
             for rng, rs in ws.conditional_formatting._cf_rules.items()]
    ws.conditional_formatting = ConditionalFormattingList()
    for sqref, rs in rules:
        moved = _shift_sqref(sqref, at)
        for rule in rs:
            ws.conditional_formatting.add(moved, rule)

    for dv in ws.data_validations.dataValidation:
        dv.sqref = MultiCellRange(_shift_sqref(dv.sqref, at))

    for r in range(1, ws.max_row + 1):
        for c in range(1, ncols + 1):
            cell = ws.cell(r, c)
            v = cell.value
            if not isinstance(v, str) or not v.startswith("="):
                continue
            if r >= at:
                cell.value = re.sub(
                    r"(\$?[A-Z]{1,3})(\d+)",
                    lambda m: f"{m.group(1)}{r}"
                    if int(m.group(2)) in (r - 1, r) else m.group(0), v)
            else:
                cell.value = _shift_formula(v, at)
    return at


# ------------------------------------------------------------------- models
class Point(BaseModel):
    unit: str | None = ""
    tag: str
    sheet_row: int | None = None
    added: bool | None = False
    type: str | None = ""
    controller: str | None = ""
    descr: str | None = ""
    addr: str | None = ""
    installed: str | None = ""
    p2p: str | None = ""
    trends: str | None = ""
    alarm: str | None = ""
    graphic: str | None = ""
    startup: str | None = ""
    notes: str | None = ""


class ExportBody(BaseModel):
    filename: str | None = None
    points: list[Point]


# ----------------------------------------------------------------- endpoints
@app.get("/export/health")
async def health():
    return {"ok": True, "templates": len(list(TEMPLATES.glob("*.xlsm")))}


@app.get("/export/template/{project_id}")
async def has_template(project_id: str, who: dict = Depends(caller)):
    await require_member(project_id, who)
    p = template_path(project_id)
    return {"exists": p.exists(), "bytes": p.stat().st_size if p.exists() else 0}


@app.post("/export/template/{project_id}")
async def put_template(
    project_id: str, file: UploadFile = File(...), who: dict = Depends(caller)
):
    await require_member(project_id, who)
    if who["user"].get("role") not in ("lead", "admin"):
        raise HTTPException(403, "Only a lead or admin can replace the template")
    raw = await file.read()
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(413, "Template is too large")
    try:
        openpyxl.load_workbook(io.BytesIO(raw), keep_vba=True)
    except Exception as exc:
        raise HTTPException(422, f"Not a readable workbook: {exc}")
    template_path(project_id).write_bytes(raw)
    return {"ok": True, "bytes": len(raw)}


@app.post("/export/p2p/{project_id}")
async def export_p2p(
    project_id: str, body: ExportBody, who: dict = Depends(caller)
):
    await require_member(project_id, who)
    tpl = template_path(project_id)
    if not tpl.exists():
        raise HTTPException(
            404, "No template uploaded for this project — upload the original .xlsm first"
        )

    wb = openpyxl.load_workbook(tpl, keep_vba=True)
    ws = find_sheet(wb)
    hdr = header_row(ws)
    cols = map_columns(ws, hdr)

    idx, bytag = {}, {}
    for r in range(hdr + 1, ws.max_row + 1):
        tag = ws.cell(r, cols["tag"]).value
        if tag is None or not str(tag).strip():
            continue
        if norm(tag) in ("engineering", "electrician", "specialist"):
            continue
        unit = ws.cell(r, cols["unit"]).value if cols["unit"] else ""
        idx[(norm(unit), norm(tag))] = r
        bytag.setdefault(norm(tag), []).append(r)

    written = cleared = matched = 0
    unmatched: list[str] = []

    added_rows = [p for p in body.points if p.added]
    for p in body.points:
        if p.added:
            continue
        row = None
        # Prefer the recorded sheet row: it survives a tag being corrected
        # in the field, which matching on text alone would not.
        if p.sheet_row and hdr < p.sheet_row <= ws.max_row:
            if norm(ws.cell(p.sheet_row, cols["tag"]).value) == norm(p.tag):
                row = p.sheet_row
        if row is None:
            row = idx.get((norm(p.unit), norm(p.tag)))
        if row is None:
            cand = bytag.get(norm(p.tag), [])
            row = cand[0] if len(cand) == 1 else None
        if row is None:
            unmatched.append(f"{p.unit} / {p.tag}")
            continue

        matched += 1
        for field in FIELD_HEADERS:
            col = cols.get(field)
            if not col:
                continue
            val = getattr(p, field, "")
            if val is None or val == "":
                continue  # blank leaves the existing cell alone
            if val == CLEAR:
                if ws.cell(row, col).value not in (None, ""):
                    cleared += 1
                ws.cell(row, col).value = None
            else:
                ws.cell(row, col).value = val
                written += 1

    # Field-added points have no row yet: put each in its unit's block so it
    # sits with its siblings and inherits that block's formatting.
    inserted = 0
    ncols = ws.max_column
    for p in added_rows:
        unit = norm(p.unit)
        last = None
        for rr in range(hdr + 1, ws.max_row + 1):
            if cols.get("unit") and norm(ws.cell(rr, cols["unit"]).value) == unit:
                last = rr
        model = last if last else ws.max_row
        at = (last + 1) if last else (ws.max_row + 1)
        insert_row_like(ws, at, model, ncols)

        msrc = model if model < at else model + 1
        for c in range(1, ncols + 1):
            fv = ws.cell(msrc, c).value
            if isinstance(fv, str) and fv.startswith("="):
                ws.cell(at, c).value = re.sub(
                    r"(\$?[A-Z]{1,3})(\d+)",
                    lambda m: f"{m.group(1)}{at}"
                    if int(m.group(2)) == msrc else m.group(0), fv)

        if cols.get("unit"):
            ws.cell(at, cols["unit"]).value = p.unit or ""
        ws.cell(at, cols["tag"]).value = p.tag
        for field in FIELD_HEADERS:
            col = cols.get(field)
            val = getattr(p, field, "") or ""
            if col and val and val != CLEAR:
                ws.cell(at, col).value = val
        headers = {norm(ws.cell(hdr, c).value): c for c in range(1, ncols + 1)}
        for label, val in (("type", p.type), ("controller", p.controller),
                           ("description", p.descr), ("address", p.addr)):
            for h, c in headers.items():
                if h.startswith(label):
                    ws.cell(at, c).value = val or ""
                    break
        if (p.notes or "").strip() and cols.get("p2p"):
            ws.cell(at, cols["p2p"]).comment = Comment(
                p.notes.strip(), "Field Checkout", height=90, width=260)
        inserted += 1

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    name = body.filename or f"P2P_{project_id}.xlsm"
    name = re.sub(r'[^A-Za-z0-9_.\- ]', "_", name)
    return StreamingResponse(
        buf,
        media_type=XLSM_MIME,
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "X-Rows-Matched": str(matched),
            "X-Cells-Written": str(written),
            "X-Cells-Cleared": str(cleared),
            "X-Unmatched": str(len(unmatched)),
            "X-Added-Points": str(inserted),
        },
    )
