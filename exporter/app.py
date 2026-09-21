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
import openpyxl
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


ADDED_SHEET = "Added in the field"
ADDED_HEADERS = [
    "Unit Tag", "Point Name", "Type", "Controller", "Description",
    "Address", "Installed and Labeled", "Point To Point",
    "Trend/History", "Alarm", "Graphic", "Startup Date", "Notes",
]


def _write_added_sheet(wb, points: list) -> None:
    """Stage field-added points on their own sheet.

    These have no row in the main sheet. Inserting one from here would break
    things quietly, so instead they land here ready to be copied into the main
    sheet in Excel, which fixes up formatting and formula ranges as it inserts.
    """
    if ADDED_SHEET in wb.sheetnames:
        del wb[ADDED_SHEET]
    ws = wb.create_sheet(ADDED_SHEET)

    ws["A1"] = "Points added in the field — not yet in the Main P2PCO Sheet"
    ws["A2"] = (
        "Insert these rows into the main sheet in Excel (right-click a row in "
        "the right unit block, Insert), then paste the values across. Inserting "
        "in Excel keeps the conditional formatting bands and the % Complete "
        "formulas correct; writing them from outside Excel does not."
    )
    for i, head in enumerate(ADDED_HEADERS, start=1):
        ws.cell(4, i).value = head

    for r, p in enumerate(points, start=5):
        vals = [
            p.unit, p.tag, p.type, p.controller, p.descr, p.addr,
            p.installed, p.p2p, p.trends, p.alarm, p.graphic, p.startup, p.notes,
        ]
        for c, v in enumerate(vals, start=1):
            ws.cell(r, c).value = v or None

    widths = [14, 34, 7, 26, 32, 11, 20, 16, 15, 12, 12, 14, 40]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[chr(64 + i)].width = w


# ------------------------------------------------------------------- models
class Point(BaseModel):
    unit: str | None = ""
    tag: str
    sheet_row: int | None = None
    # Points added at the panel that have no row in the workbook yet.
    added: bool = False
    type: str | None = ""
    descr: str | None = ""
    addr: str | None = ""
    controller: str | None = ""
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
    added: list[Point] = []

    for p in body.points:
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
            # A field-added point. We deliberately do NOT insert a row into the
            # main sheet: openpyxl does not shift conditional-formatting ranges
            # or the M2 rollup, so a mid-sheet insert silently misaligns the
            # 61 CF bands and the per-row % Complete formulas. Excel updates
            # those correctly on its own, so these go to a staging sheet for a
            # human to insert properly.
            if p.added:
                added.append(p)
            else:
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

    if added:
        _write_added_sheet(wb, added)

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
            "X-Added-Points": str(len(added)),
        },
    )
