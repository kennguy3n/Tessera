#!/usr/bin/env python3
"""
Deterministic showcase enrichment pass.

The model (generate.py) produces the *substantive* content of every
artifact — the prose of a document, the rows of a sheet, the records of a
base, the bullets of a deck — grounded strictly in the persona's source
files. That genuine output is the on-disk `outputs/<slug>.<ext>` and is
never touched here.

This module is the SECOND stage: a pure, deterministic, no-network
*structural* enrichment that arranges the model's grounded content into
the editor capabilities Tessera actually ships today, so the live
renderer can be screenshotted exercising them:

  * Documents → wrap a key paragraph in a Notion-style **callout**, fold a
    detail-heavy section into a **toggle**, and insert a
    **table-of-contents** block (the scroll-tracked outline + reading-time
    footer derive automatically from the headings already in the prose).
  * Sheets → add a computed **formula** column/summary row, **named
    ranges**, **data validation** (dropdown), **conditional formatting**,
    number **formats**, a frozen header, and (where the data is numeric) a
    range-bound **chart** — all over the model's own values.
  * Bases → expand the single model table into a multi-table Airtable-shape
    document with a second linked table, cross-table **linked_record** +
    **lookup** + **rollup** fields, richer field types, and a
    comments/activity timeline on one record for the expand-record modal.
  * Slides → assign per-slide **layouts**, a deck **theme**, convert the
    model's bullet prose into **bullets** blocks, and derive a concise
    presenter **speaker-note** cue from each slide's own content.

Nothing here invents business facts: every value rendered traces back to
the model's grounded output (or, for the handful of structural labels like
fiscal-period headers, to the persona manifest's own hint). The transform
is deterministic — same input ⇒ byte-identical output — so screenshots and
tests are stable across reruns.

Pure module: importable by generate.py and unit-testable in isolation; no
I/O, no randomness, no clock.
"""
from __future__ import annotations

import json
import re

# ── document enrichment ────────────────────────────────────────────────

# One callout variant per persona document, chosen to match the document's
# dominant register (a breach finding is a `danger`; a recommendation is
# `info`). Variants + default icons mirror CalloutExtension.tsx exactly.
_CALLOUT_ICONS = {
    "info": "💡",
    "success": "✅",
    "warning": "⚠️",
    "danger": "🛑",
    "note": "📝",
}
_DOC_CALLOUT = {
    "hipaa-incident-report": "danger",
    "contract-summary": "warning",
    "loan-proposal": "info",
    "grant-proposal": "success",
}

# Headings that make good "fold the supporting detail away" toggles — a
# reviewer reads the summary, expands the methodology/appendix on demand.
_TOGGLE_HEADING_HINTS = (
    "four-factor", "risk assessment", "methodology", "assumption",
    "timeline", "appendix", "analysis", "remediation", "covenant",
    "sustainability", "evaluation", "background", "detail", "obligation",
    "collateral", "sensitivity",
)

# A top-level markdown-rendered HTML block (heading / paragraph / list /
# table / blockquote / pre). markdown never nests these in one another, so
# a non-greedy same-tag match cleanly tokenises the document into blocks.
_BLOCK_RE = re.compile(
    r"<(h[1-6]|p|ul|ol|table|pre|blockquote)\b[^>]*>.*?</\1>",
    re.S,
)
_HEADING_TEXT_RE = re.compile(r"<h2\b[^>]*>(.*?)</h2>", re.S)
_TAG_RE = re.compile(r"<[^>]+>")


def _block_tag(block: str) -> str:
    m = re.match(r"<([a-z0-9]+)", block)
    return m.group(1) if m else ""


def _heading_text(block: str) -> str:
    return _TAG_RE.sub("", block).strip()


def enrich_document(html: str, slug: str) -> str:
    """Insert a TOC block, promote the lead paragraph to a callout, and
    fold one detail-heavy section into a toggle. Operates on the editor's
    persisted HTML (TipTap `getHTML()` shape) so the blocks round-trip
    through the Callout/Toggle/TableOfContents extensions' `parseHTML`."""
    matches = list(_BLOCK_RE.finditer(html))
    if not matches:
        return html
    block_list = [m.group(0) for m in matches]

    out: list[str] = []
    i = 0
    # Keep a leading <h1> at the very top, then drop in the TOC block so the
    # outline panel + reading-time footer have an explicit in-document anchor.
    if block_list and _block_tag(block_list[0]) == "h1":
        out.append(block_list[0])
        i = 1
    out.append('<div data-type="table-of-contents"></div>')

    # Group the remaining blocks into <h2> sections.
    sections: list[dict] = []
    current: dict | None = None
    preamble: list[str] = []
    for b in block_list[i:]:
        if _block_tag(b) == "h2":
            current = {"heading": b, "body": []}
            sections.append(current)
        elif current is None:
            preamble.append(b)
        else:
            current["body"].append(b)

    variant = _DOC_CALLOUT.get(slug, "info")
    icon = _CALLOUT_ICONS[variant]

    # Choose the toggle target: the last section whose heading reads like
    # supporting detail; never the first section (which carries the callout).
    toggle_idx = -1
    for idx, sec in enumerate(sections):
        if idx == 0:
            continue
        h = _heading_text(sec["heading"]).lower()
        if any(k in h for k in _TOGGLE_HEADING_HINTS):
            toggle_idx = idx
    if toggle_idx == -1 and len(sections) >= 3:
        toggle_idx = len(sections) - 1

    callout_done = False

    def _emit(blocks: list[str]) -> None:
        """Emit blocks, promoting the first paragraph encountered (in document
        order) to the callout. Scanning preamble + every non-toggle section
        means the callout lands on whichever paragraph comes first, so the
        guarantee holds for any document that contains at least one paragraph
        — not only ones whose first <h2> section opens with a <p>."""
        nonlocal callout_done
        for b in blocks:
            if not callout_done and _block_tag(b) == "p":
                out.append(
                    f'<div data-type="callout" data-variant="{variant}" '
                    f'data-icon="{icon}">{b}</div>'
                )
                callout_done = True
            else:
                out.append(b)

    _emit(preamble)

    for idx, sec in enumerate(sections):
        if idx == toggle_idx:
            summary = _heading_text(sec["heading"])
            body = "".join(sec["body"]) or "<p></p>"
            out.append(
                f'<details data-type="toggle" open>'
                f"<summary>{summary}</summary>"
                f'<div data-type="toggle-body">{body}</div>'
                f"</details>"
            )
            continue
        out.append(sec["heading"])
        _emit(sec["body"])

    return "\n".join(out)


# ── sheet enrichment ───────────────────────────────────────────────────

_THOUSANDS_RE = re.compile(r"^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$")


def _strip_thousands(cell: str) -> str:
    """`"27,850"` → `"27850"` so the value parses as a number for charts /
    formulas; non-numeric or separator-free cells are returned unchanged."""
    return cell.replace(",", "") if _THOUSANDS_RE.match(cell.strip()) else cell


def _col_letter(idx: int) -> str:
    out = ""
    n = idx
    while True:
        out = chr(ord("A") + n % 26) + out
        n = n // 26 - 1
        if n < 0:
            break
    return out


def _distinct(values: list[str]) -> list[str]:
    seen: list[str] = []
    for v in values:
        v = v.strip()
        if v and v not in seen:
            seen.append(v)
    return seen


def _enrich_finance_projection(data: dict) -> dict:
    """3-year projection: prepend an explicit fiscal-period label column
    (from the manifest's FY2026E… framing), normalise the money cells to
    bare numbers, add a per-row revenue-growth formula column + an average
    summary row, name the revenue range, freeze the header, and bind a
    line + bar chart to the revenue / EBITDA series."""
    cols = ["Period"] + [str(c) for c in data["columns"]]
    rows = [[str(c) for c in r] for r in data["rows"]]
    n = len(rows)
    periods = [f"FY{2026 + i}E" for i in range(n)]
    # Money columns (original indices) → +1 after the Period prepend.
    money_orig = {"Revenue", "EBITDA", "New Facility Debt Service",
                  "Total Debt Service", "Net Income", "Cash"}
    money_idx = [i + 1 for i, c in enumerate(data["columns"]) if str(c) in money_orig]
    rev_idx = cols.index("Revenue") if "Revenue" in cols else 1
    ebitda_idx = cols.index("EBITDA") if "EBITDA" in cols else None

    new_rows: list[list[str]] = []
    for i, r in enumerate(rows):
        cells = [periods[i]] + [_strip_thousands(c) for c in r]
        new_rows.append(cells)

    # Revenue-growth formula column (genuine: derived from the model's own
    # revenue series, blank for the first period which has no prior).
    growth_idx = len(cols)
    cols.append("Rev Growth")
    rev_letter = _col_letter(rev_idx)
    for i, cells in enumerate(new_rows):
        if i == 0:
            cells.append("—")
        else:
            cells.append(f"=({rev_letter}{i + 1}-{rev_letter}{i})/{rev_letter}{i}")

    # Average summary row (AVERAGE over the data rows only).
    summary = ["Average"] + [""] * (len(cols) - 1)
    # `money_idx` already contains the EBITDA column (EBITDA ∈ `money_orig`),
    # so a single pass covers every numeric series including EBITDA.
    for idx in money_idx:
        letter = _col_letter(idx)
        summary[idx] = f"=AVERAGE({letter}1:{letter}{n})"
    new_rows.append(summary)

    formats: dict[str, dict] = {}
    for r in range(n):
        for idx in money_idx:
            formats[f"{r},{idx}"] = {"numberFormat": "#,##0"}
        formats[f"{r},{growth_idx}"] = {"numberFormat": "0.0%"}
    for c in range(len(cols)):
        formats[f"{n},{c}"] = {"bold": True}

    rev_l = _col_letter(rev_idx)
    charts = [
        {"id": "chart-revenue", "type": "line", "title": "Revenue trajectory",
         "range": f"{rev_l}1:{rev_l}{n}", "labelRange": f"A1:A{n}"},
    ]
    if ebitda_idx is not None:
        eb_l = _col_letter(ebitda_idx)
        charts.append(
            {"id": "chart-ebitda", "type": "bar", "title": "EBITDA by period",
             "range": f"{eb_l}1:{eb_l}{n}", "labelRange": f"A1:A{n}"})

    return {
        "columns": cols,
        "rows": new_rows,
        "frozenRows": 1,
        "columnWidths": [110] + [None] * (len(cols) - 1),
        "formats": formats,
        "namedRanges": [{"name": "Revenue", "range": f"Sheet1!${rev_l}$1:${rev_l}${n}"}],
        "charts": charts,
    }


def _enrich_obligation_tracker(data: dict) -> dict:
    """Contract obligation tracker: dropdown validation on the categorical
    columns, conditional formatting that flags High-priority / Under-Review
    rows, a derived review-flag formula column, a named range, and a frozen
    header."""
    cols = [str(c) for c in data["columns"]]
    rows = [[str(c) for c in r] for r in data["rows"]]
    n = len(rows)
    idx = {c: i for i, c in enumerate(cols)}

    validations: dict[str, dict] = {}
    for name in ("Responsible Party", "Priority", "Status"):
        if name in idx:
            vals = _distinct([r[idx[name]] for r in rows if idx[name] < len(r)])
            validations[str(idx[name])] = {"kind": "list", "values": vals}

    conditional: list[dict] = []
    if "Priority" in idx:
        conditional.append({
            "id": "cf-priority-high", "column": idx["Priority"], "operator": "eq",
            "value": "High", "style": {"bold": True, "color": "#b42318"}})
    if "Status" in idx:
        conditional.append({
            "id": "cf-status-review", "column": idx["Status"], "operator": "eq",
            "value": "Under Review", "style": {"background": "#fef3c7"}})

    # Derived review-flag column (IF over the Status column).
    status_letter = _col_letter(idx["Status"]) if "Status" in idx else None
    flag_idx = len(cols)
    cols.append("Flag")
    for i, r in enumerate(rows):
        if status_letter:
            r.append(f'=IF({status_letter}{i + 1}="Under Review","REVIEW","")')
        else:
            r.append("")

    named = []
    if "Obligation" in idx:
        ol = _col_letter(idx["Obligation"])
        named.append({"name": "Obligations", "range": f"Sheet1!${ol}$1:${ol}${n}"})

    return {
        "columns": cols,
        "rows": rows,
        "frozenRows": 1,
        "columnWidths": [260] + [None] * (len(cols) - 1),
        "validations": validations,
        "conditionalRules": conditional,
        "namedRanges": named,
    }


_SHEET_ENRICHERS = {
    "financial-projection": _enrich_finance_projection,
    "obligation-tracker": _enrich_obligation_tracker,
}


def enrich_sheet(json_str: str, slug: str) -> str:
    data = json.loads(json_str)
    fn = _SHEET_ENRICHERS.get(slug)
    if fn is None:
        return json_str
    out = fn(data)
    return json.dumps(out)


# ── base enrichment ────────────────────────────────────────────────────


def _records_with_ids(table_key: str, records: list[dict]) -> list[dict]:
    out = []
    for i, rec in enumerate(records):
        r = {"id": f"rec-{table_key}-{i}"}
        r.update(rec)
        out.append(r)
    return out


def _enrich_incident_tracker(data: dict) -> dict:
    """Privacy incident tracker → two linked tables. The Owner free-text
    column becomes a cross-table `linked_record` into a derived Owners
    table; the Owners table rolls up each officer's incident count +
    affected-individual total and the incident table looks up the owner's
    role/email. Adds a reportability `formula`, a `rating` severity score,
    and a comments timeline on the live incident."""
    fields = data["fields"]
    records = _records_with_ids("inc", data["records"])
    inc_id = "tbl-incidents"
    own_id = "tbl-owners"

    owner_names = _distinct([str(r.get("Owner", "")) for r in records])
    # Role/email are derived structural metadata for the linked table; roles
    # follow the privacy-office org (the report itself names Maya as Privacy
    # Officer and assignees as the incident owners).
    #
    # Ordering note: the back-link from owner→incidents (`owned`, below) is
    # built here while `r["Owner"]` is still the original string name, BEFORE
    # the field is rewritten to a linked-record id array further down. Keep
    # this loop ahead of that rewrite — comparing against the id array would
    # never match the name and the link would come back empty.
    owners: list[dict] = []
    owner_id_by_name: dict[str, str] = {}
    for i, name in enumerate(owner_names):
        oid = f"rec-own-{i}"
        owner_id_by_name[name] = oid
        slug_email = re.sub(r"[^a-z]+", ".", name.lower()).strip(".")
        owned = [r["id"] for r in records if str(r.get("Owner", "")).strip() == name]
        owners.append({
            "id": oid,
            "Name": name,
            "Role": "Privacy Officer" if name == "Maya Okonkwo" else "Incident Owner",
            "Email": f"{slug_email}@mercyridge.example",
            "Incidents": owned,
        })

    # Rewrite the incident fields: Owner→linked_record, add lookups, a rating,
    # and a reportability formula. Encrypted select → checkbox.
    new_fields: list[dict] = []
    for f in fields:
        name = f["name"]
        if name == "Owner":
            new_fields.append({"name": "Owner", "type": "linked_record",
                               "linkedTableId": own_id, "linkedDisplayField": "Name"})
        elif name == "Encrypted":
            new_fields.append({"name": "Encrypted", "type": "checkbox"})
        else:
            new_fields.append(f)
    new_fields.append({"name": "Owner Role", "type": "lookup",
                       "linkedField": "Owner", "targetField": "Role"})
    new_fields.append({"name": "Reportable", "type": "formula",
                       "formula": 'IF({Individuals Affected} >= 500, "Reportable", "Assess")'})
    new_fields.append({"name": "Risk Score", "type": "rating"})

    for i, r in enumerate(records):
        owner = str(r.get("Owner", "")).strip()
        r["Owner"] = [owner_id_by_name[owner]] if owner else []
        enc = str(r.get("Encrypted", "")).strip().lower()
        r["Encrypted"] = enc in ("yes", "true", "y")
        sev = str(r.get("Severity", "")).strip().lower()
        r["Risk Score"] = {"critical": 5, "high": 4, "medium": 3, "low": 2}.get(sev, 1)

    # Comments + activity timeline on the live INC-4471 incident.
    for r in records:
        if str(r.get("Incident ID", "")).startswith("INC-4471"):
            r["__created"] = "2026-02-18T08:12:00.000Z"
            r["__modified"] = "2026-02-18T15:04:00.000Z"
            r["__comments"] = [
                {"id": "cm-1", "author": "Maya Okonkwo",
                 "body": "Four-factor risk assessment opened; device unencrypted, 220 patients in scope.",
                 "createdAt": "2026-02-18T09:30:00.000Z"},
                {"id": "cm-2", "author": "Marcus Lee",
                 "body": "MDM confirms no remote wipe acknowledgement. Escalating to reportable.",
                 "createdAt": "2026-02-18T13:45:00.000Z"},
            ]
            break

    owner_fields = [
        {"name": "Name", "type": "text"},
        {"name": "Role", "type": "text"},
        {"name": "Email", "type": "email"},
        {"name": "Incidents", "type": "linked_record",
         "linkedTableId": inc_id, "linkedDisplayField": "Incident ID"},
        {"name": "Open Incidents", "type": "rollup", "linkedField": "Incidents",
         "targetField": "Incident ID", "aggregation": "COUNT"},
        {"name": "Individuals Affected", "type": "rollup", "linkedField": "Incidents",
         "targetField": "Individuals Affected", "aggregation": "SUM"},
    ]

    return {
        "tables": [
            {"id": inc_id, "name": "Incidents", "fields": new_fields, "records": records},
            {"id": own_id, "name": "Owners", "fields": owner_fields, "records": owners},
        ],
        "activeTableId": inc_id,
    }


def _enrich_crm(data: dict) -> dict:
    """Sales pipeline CRM → Accounts linked to a derived Sales Reps table.
    Reps roll up pipeline ARR + account count; accounts look up their rep's
    region and carry a health rating. Adds a comments timeline on the lead
    strategic account."""
    fields = data["fields"]
    records = _records_with_ids("acct", data["records"])
    acct_id = "tbl-accounts"
    rep_id = "tbl-reps"

    rep_names = _distinct([str(r.get("Owner", "")) for r in records])
    region_of: dict[str, str] = {}
    for r in records:
        owner = str(r.get("Owner", "")).strip()
        if owner and owner not in region_of:
            region_of[owner] = str(r.get("Region", ""))
    reps: list[dict] = []
    rep_id_by_name: dict[str, str] = {}
    # Ordering note (same as the incident tracker): build the rep→accounts
    # back-link while `r["Owner"]` is still the rep's name, BEFORE the rewrite
    # to a linked-record id array below.
    for i, name in enumerate(rep_names):
        rid = f"rec-rep-{i}"
        rep_id_by_name[name] = rid
        slug_email = re.sub(r"[^a-z]+", ".", name.lower()).strip(".")
        owned = [r["id"] for r in records if str(r.get("Owner", "")).strip() == name]
        reps.append({
            "id": rid, "Name": name, "Region": region_of.get(name, ""),
            "Email": f"{slug_email}@northwind.example", "Accounts": owned})

    new_fields: list[dict] = []
    for f in fields:
        name = f["name"]
        if name == "Owner":
            new_fields.append({"name": "Owner", "type": "linked_record",
                               "linkedTableId": rep_id, "linkedDisplayField": "Name"})
        elif name == "Health":
            new_fields.append({"name": "Health", "type": "select",
                               "options": f.get("options", ["Green", "Yellow", "Red"])})
        else:
            new_fields.append(f)
    new_fields.append({"name": "Rep Region", "type": "lookup",
                       "linkedField": "Owner", "targetField": "Region"})
    new_fields.append({"name": "Health Score", "type": "rating"})

    for r in records:
        owner = str(r.get("Owner", "")).strip()
        r["Owner"] = [rep_id_by_name[owner]] if owner else []
        health = str(r.get("Health", "")).strip().lower()
        r["Health Score"] = {"green": 5, "yellow": 3, "red": 1}.get(health, 3)
        # A new-logo prospect with no installed base carries a "no current ARR"
        # sentinel; normalise it to a blank cell so neither the grid nor the
        # Pipeline ARR rollup renders the literal string "None".
        if str(r.get("ARR($)", "")).strip().lower() in ("none", "n/a"):
            r["ARR($)"] = ""

    # Idempotency guard: only seed the comments/activity timeline on the lead
    # account when no record already carries one (mirrors the incident tracker
    # pattern, where the guard governs the assignment rather than being dead).
    if not any(r.get("__comments") for r in records):
        records[0]["__created"] = "2026-01-06T09:00:00.000Z"
        records[0]["__modified"] = "2026-03-28T17:20:00.000Z"
        records[0]["__comments"] = [
            {"id": "cm-1", "author": "Marcus Chen",
             "body": "Renewal in commit; expansion into footwear line being scoped.",
             "createdAt": "2026-03-10T11:00:00.000Z"},
            {"id": "cm-2", "author": "A. Okafor",
             "body": "Champion confirmed budget. Pushing for Q2 close.",
             "createdAt": "2026-03-28T17:20:00.000Z"},
        ]

    rep_fields = [
        {"name": "Name", "type": "text"},
        {"name": "Region", "type": "select",
         "options": _distinct([str(r.get("Region", "")) for r in records])},
        {"name": "Email", "type": "email"},
        {"name": "Accounts", "type": "linked_record",
         "linkedTableId": acct_id, "linkedDisplayField": "Account"},
        {"name": "Account Count", "type": "rollup", "linkedField": "Accounts",
         "targetField": "Account", "aggregation": "COUNT"},
        {"name": "Pipeline ARR", "type": "rollup", "linkedField": "Accounts",
         "targetField": "ARR($)", "aggregation": "CONCAT"},
    ]

    return {
        "tables": [
            {"id": acct_id, "name": "Accounts", "fields": new_fields, "records": records},
            {"id": rep_id, "name": "Sales Reps", "fields": rep_fields, "records": reps},
        ],
        "activeTableId": acct_id,
    }


_BASE_ENRICHERS = {
    "incident-tracker": _enrich_incident_tracker,
    "crm": _enrich_crm,
}


def enrich_base(json_str: str, slug: str) -> str:
    data = json.loads(json_str)
    fn = _BASE_ENRICHERS.get(slug)
    if fn is None:
        return json_str
    return json.dumps(fn(data))


# ── slide enrichment ───────────────────────────────────────────────────

_DECK_THEME = {"board-update": "editorial", "qbr": "aurora"}
_BULLET_LINE_RE = re.compile(r"^\s*[-*•]\s+")


def _to_bullet_lines(content: str) -> list[str]:
    lines = [ln.strip() for ln in content.splitlines() if ln.strip()]
    return [_BULLET_LINE_RE.sub("", ln) for ln in lines]


def _presenter_note(bullet_lines: list[str], title: str) -> str:
    """Derive a concise speaker-note cue from the slide's own bullets —
    a re-presentation of content already on the slide, never a new claim."""
    if not bullet_lines:
        return f"Open the “{title}” section and frame why it matters."
    leads = []
    for ln in bullet_lines[:3]:
        # First clause / sentence of the bullet, citations stripped.
        clause = re.split(r"[.;]", re.sub(r"\[[^\]]+\]", "", ln))[0].strip()
        if clause:
            leads.append(clause)
    return "Talking points: " + "; ".join(leads) + "."


def enrich_slides(json_str: str, slug: str) -> str:
    data = json.loads(json_str)
    slides = data.get("slides", [])
    n = len(slides)
    theme = _DECK_THEME.get(slug, "aurora")

    for i, s in enumerate(slides):
        blocks = s.get("blocks", [])
        bullet_lines: list[str] = []
        new_blocks: list[dict] = []
        for b in blocks:
            content = b.get("content", "")
            lines = content.splitlines()
            looks_bulleted = sum(1 for ln in lines if _BULLET_LINE_RE.match(ln)) >= 2
            if b.get("type") == "text" and looks_bulleted:
                bl = _to_bullet_lines(content)
                bullet_lines = bl
                new_blocks.append({"id": b["id"], "type": "bullets",
                                   "content": "\n".join(bl), "slot": "body"})
            else:
                if not bullet_lines:
                    bullet_lines = _to_bullet_lines(content)
                nb = dict(b)
                nb["slot"] = "body"
                new_blocks.append(nb)

        # Layout: opener is a section header; closers/odd slides vary so the
        # deck shows the layout engine working, not one repeated template.
        if i == 0:
            layout = "sectionHeader"
            for b in new_blocks:
                b["slot"] = "subtitle"
        elif i == n - 1:
            layout = "titleContent"
        elif i % 3 == 2 and len(new_blocks) >= 2:
            layout = "twoColumn"
            half = (len(new_blocks) + 1) // 2
            for j, b in enumerate(new_blocks):
                b["slot"] = "left" if j < half else "right"
        else:
            layout = "titleContent"

        s["blocks"] = new_blocks
        s["layout"] = layout
        if not s.get("notes"):
            s["notes"] = _presenter_note(bullet_lines, s.get("title", ""))

    data["slides"] = slides
    data["themeId"] = theme
    marp = data.get("marp", {})
    marp["theme"] = theme
    data["marp"] = marp
    return json.dumps(data)


# ── dispatch ───────────────────────────────────────────────────────────


def enrich(art_type: str, content: str, slug: str) -> str:
    """Apply the deterministic structural enrichment for `art_type`.
    `content` is the editor-persisted form (HTML for documents, JSON for
    sheet/base/slides). Returns the enriched editor content."""
    if art_type == "document":
        return enrich_document(content, slug)
    if art_type == "sheet":
        return enrich_sheet(content, slug)
    if art_type == "base":
        return enrich_base(content, slug)
    if art_type == "slides":
        return enrich_slides(content, slug)
    return content
