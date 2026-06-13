#!/usr/bin/env python3
"""
Showcase artifact generator.

Reads scripts/showcase/personas.yaml, and for each persona artifact:
  1. Loads the REAL Tessera template YAML (its section prompts / structure).
  2. Loads the persona's input source files (docs/showcase/artifacts/<id>/inputs).
  3. Runs each template section prompt through Tessera's real on-device runtime
     (the PrismML llama.cpp `llama-server`, OpenAI-compatible) using a Tessera
     DESIGN text model from sidecars/models.json (the Ternary-Bonsai family),
     grounded strictly in the source material, asking it to cite source filenames.
  4. Assembles the artifact in the exact on-disk content format each Tessera
     editor expects (markdown for documents; JSON for slides/sheet/base).
  5. Writes:
       - docs/showcase/artifacts/<id>/prompts/<slug>.md   (transparent prompt log)
       - docs/showcase/artifacts/<id>/outputs/<slug>.<ext> (the artifact content)
       - docs/showcase/artifacts/<id>/outputs/<slug>.preview.md (human-readable)
       - apps/desktop/renderer/src/showcase/generated/<id>.ts (renderer dataset)

Genuine model output — nothing here is hand-written prose.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

import yaml

import enrich  # local: deterministic structural enrichment (same dir on sys.path)

REPO = Path(__file__).resolve().parents[2]
MANIFEST = REPO / "scripts/showcase/personas.yaml"
MODEL_REGISTRY = REPO / "sidecars/models.json"

# Tessera's real on-device text runtime is the PrismML llama.cpp fork's
# `llama-server` (OpenAI-compatible HTTP API). Point this at a running server;
# the default matches the fork's conventional local port. We deliberately do NOT
# default to a generic Ollama endpoint — the showcase must run the product's own
# runtime + a design model, never an off-design stand-in.
LLM_BASE_URL = os.environ.get("TESSERA_LLM_BASE_URL", "http://127.0.0.1:8080")


def log(msg: str) -> None:
    print(msg, flush=True)


def load_design_text_models() -> dict:
    """The set of models the showcase is ALLOWED to use = the `text`-capability
    entries in Tessera's real model registry (sidecars/models.json). Anything
    outside this set is off-design and must never generate showcase artifacts."""
    reg = json.loads(MODEL_REGISTRY.read_text())
    return {m["id"]: m for m in reg.get("models", []) if m.get("capability") == "text"}


def assert_design_model(model_id: str) -> dict:
    """Guard: refuse to generate with any model that is not part of Tessera's
    shipped design. Returns the registry entry for the (approved) model."""
    allowed = load_design_text_models()
    if model_id not in allowed:
        listing = "\n  ".join(sorted(allowed))
        raise SystemExit(
            f"Refusing to generate with off-design model {model_id!r}.\n"
            f"Showcase artifacts must be produced by a Tessera DESIGN text model "
            f"(capability=text in sidecars/models.json):\n  {listing}\n"
            "If a model is genuinely part of the product, add it to the registry "
            "first; do not point the showcase at an external/stand-in model."
        )
    return allowed[model_id]


def llm_complete(model: str, prompt: str, system: str, *, num_predict: int = 600,
                 temperature: float = 0.4,
                 response_format: dict | None = None) -> tuple[str, str]:
    """Call the runtime and return (text, finish_reason). `finish_reason` is
    "stop" when the model ended naturally and "length" when it hit the token
    budget mid-output (so the caller can trim a dangling sentence)."""
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "temperature": temperature,
        "max_tokens": num_predict,
        "top_p": 0.9,
    }
    # Constrained decoding: the real runtime (llama.cpp/llama-server) can force
    # the model to emit JSON matching a schema. This is what makes a small
    # on-device model reliably produce valid structured output (sheets/bases).
    if response_format is not None:
        payload["response_format"] = response_format
    body = json.dumps(payload).encode()
    req = urllib.request.Request(f"{LLM_BASE_URL}/v1/chat/completions", data=body,
                                 headers={"Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                data = json.loads(r.read())
            choice = data["choices"][0]
            text = (choice["message"]["content"] or "").strip()
            finish = choice.get("finish_reason") or "stop"
            if text:
                return text, finish
            # HTTP succeeded but the model produced no content. Log + back off
            # so an "empty completion" failure is distinguishable from an
            # "unreachable server" one in the generation log (same retry budget).
            log(f"    ! llm-server returned empty text (attempt {attempt+1}); retrying")
            time.sleep(2)
        except Exception as e:  # noqa: BLE001
            log(f"    ! llm-server error (attempt {attempt+1}): {e}")
            time.sleep(2)
    raise RuntimeError("llm-server returned no text after retries")


def llm_generate(model: str, prompt: str, system: str, *, num_predict: int = 600,
                 temperature: float = 0.4, response_format: dict | None = None) -> str:
    return llm_complete(model, prompt, system, num_predict=num_predict,
                        temperature=temperature, response_format=response_format)[0]


def load_inputs(persona_id: str) -> tuple[str, list[str]]:
    in_dir = REPO / "docs/showcase/artifacts" / persona_id / "inputs"
    files = sorted(in_dir.glob("*"))
    names = [f.name for f in files]
    blocks = []
    for f in files:
        blocks.append(f"=== SOURCE FILE: {f.name} ===\n{f.read_text()}")
    return "\n\n".join(blocks), names


def clean(text: str) -> str:
    # Strip wrapping code fences / leading boilerplate the model sometimes adds.
    text = text.strip()
    text = re.sub(r"^```[a-zA-Z]*\n", "", text)
    text = re.sub(r"\n```$", "", text)
    # Drop a leading echoed heading like "## Section Title" duplicate handled by caller.
    return text.strip()


def normalize_citations(text: str) -> str:
    # Canonicalize every way the on-device model cites a source file into the
    # single inline form Tessera documents and the UI / citation counter expect:
    #   [NN-source-file.md]
    # The small model variously emits markdown links with dead anchors,
    # parenthesized filenames, or "Source: <file>" notes (with or without
    # brackets / emphasis); collapse them all to "[file]".
    FILE = r"([A-Za-z0-9][\w.\-]*\.md)"
    # 1. markdown link with dead anchor:  [file](#anchor) -> [file]
    text = re.sub(r"\[" + FILE + r"\]\(#[^)]*\)", r"[\1]", text)
    # 2. parenthesized "Source:" note, bracketed or not:
    #    (Source: [file]) / (Source: file) -> [file]
    text = re.sub(r"\(\s*Source:\s*\[?" + FILE + r"\]?\s*\)", r"[\1]", text,
                  flags=re.IGNORECASE)
    # 3. emphasized source note:  *Source: file* / _Source: file_ -> [file]
    text = re.sub(r"[*_]+\s*Source:\s*\[?" + FILE + r"\]?\s*[*_]+", r"[\1]", text,
                  flags=re.IGNORECASE)
    # 4. plain "Source: [file]" / "Source: file" -> [file]. The negative
    #    lookbehind keeps a mid-sentence "... data Source: x.md" from being
    #    rewritten into an orphaned "... data [x.md]"; only a standalone
    #    "Source:" citation note (not preceded by a word char) is collapsed.
    text = re.sub(r"(?<![A-Za-z])Source:\s*\[?" + FILE + r"\]?", r"[\1]", text,
                  flags=re.IGNORECASE)
    # 5. bare parenthesized filename:  (file) -> [file]. The negative lookbehind
    #    keeps the target of a real markdown link [text](file.md) intact, which
    #    would otherwise be rewritten into a broken reference-style [text][file.md].
    text = re.sub(r"(?<!\])\(\s*" + FILE + r"\s*\)", r"[\1]", text)
    # 6. collapse any residual parens left around an already-bracketed file:
    #    ([file]) -> [file]
    text = re.sub(r"\(\s*(\[" + FILE + r"\])\s*\)", r"\1", text)
    # 7. bare standalone filename the model left uncited: "... in 01-foo.md" ->
    #    "... in [01-foo.md]". The model sometimes omits the brackets the prompt
    #    asks for; bracket a lone filename so it still renders and counts as a
    #    citation. The lookbehind avoids one already inside [..], (..), or a path
    #    (markdown-link target), and the lookahead avoids one already closed by
    #    "]"/")".
    text = re.sub(r"(?<![\[\(/\w.-])" + FILE + r"(?![\]\)])", r"[\1]", text)
    return text


def strip_echoed_title(body: str, title: str) -> str:
    # Models frequently restate the section heading despite instructions. Drop a
    # leading echo of the title, whether emitted as a markdown heading
    # ("## Incident Summary") or as a bare/emphasised plain-text line
    # ("Incident Summary" / "**Incident Summary**") before the real body.
    lines = body.split("\n")
    norm = re.sub(r"[^a-z0-9]", "", title.lower())
    while lines:
        first = lines[0].strip()
        if not first:
            lines.pop(0)
            continue
        heading = re.match(r"^#{1,6}\s+(.*)$", first)
        if heading:
            htext = re.sub(r"[^a-z0-9]", "", heading.group(1).lower())
            if htext and (htext in norm or norm in htext):
                lines.pop(0)
                continue
        # Plain-text echo: normalize the line identically to `norm` (drop every
        # non-[a-z0-9] char) and compare for an EXACT match. Using the same
        # normalization means a symbol-bearing title (e.g. "Risk Assessment
        # (45 CFR 164.402)") is still caught, while a real sentence that merely
        # starts with the title's words is left intact.
        plain = re.sub(r"[^a-z0-9]", "", first.lower())
        if plain and plain == norm:
            lines.pop(0)
            continue
        break
    return "\n".join(lines).strip()


def trim_dangling_sentence(body: str) -> str:
    """When a section was cut off at the token budget (finish_reason=="length"),
    the trailing line is usually a half-written sentence. Trim back to the last
    complete sentence so the artifact reads cleanly. Structural trailing lines
    (table rows, dividers) are left untouched."""
    lines = body.rstrip().split("\n")
    while lines:
        last = lines[-1].rstrip()
        stripped = last.strip()
        if not stripped:
            lines.pop()
            continue
        # Tables/dividers don't end in sentence punctuation. Keep a complete
        # row (ends with a closing "|") or a divider, but drop a trailing row
        # the budget cut left half-written (no closing pipe AND fewer columns
        # than the row above it).
        if "|" in stripped or set(stripped) <= set("-—| "):
            if stripped.endswith("|") or set(stripped) <= set("-—| "):
                break
            prev = next((l for l in reversed(lines[:-1]) if l.strip()), "")
            if prev.count("|") > stripped.count("|"):
                lines.pop()
                continue
            break
        # Already ends cleanly (sentence punctuation, a closing citation
        # bracket, or a closing quote/paren).
        if re.search(r"[.!?:)\]\"'’”]$", stripped):
            break
        # Trim to the last sentence boundary within the trailing line, ignoring
        # a leading list marker ("2." / "-") so we never mistake its dot for a
        # sentence end and leave a bare marker behind.
        marker = re.match(r"^\s*(?:\d+[.)]|[-*+])\s+", last)
        start = marker.end() if marker else 0
        bounds = list(re.finditer(r"[.!?](?=\s|$)", last[start:]))
        if bounds:
            lines[-1] = last[: start + bounds[-1].end()].rstrip()
            break
        # … otherwise the whole line is a fragment (incl. a marker-only stub):
        # drop it and re-check the line above (handles a dangling list item
        # spread across the budget cut).
        lines.pop()
    return "\n".join(lines).strip()


def _parse_num(cell: str):
    """If `cell` is a single number (optionally bold, $-prefixed, with thousands
    separators), return (value, prefix, bold, commas); else None."""
    s = cell.strip()
    bold = False
    m = re.fullmatch(r"\*\*(.*)\*\*", s)
    if m:
        bold, s = True, m.group(1).strip()
    prefix = ""
    if s.startswith("$"):
        prefix, s = "$", s[1:].strip()
    commas = "," in s
    t = s.replace(",", "")
    if re.fullmatch(r"-?\d+(\.\d+)?", t):
        return float(t), prefix, bold, commas
    return None


def _fmt_num(val: float, prefix: str, bold: bool, commas: bool) -> str:
    if val == int(val):
        num = f"{int(val):,}" if commas else str(int(val))
    else:
        num = f"{val:,.2f}" if commas else f"{val:.2f}"
    out = f"{prefix}{num}"
    return f"**{out}**" if bold else out


def _split_row(row: str) -> list[str]:
    s = row.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def _is_total_label(s: str) -> bool:
    s2 = re.sub(r"[*_`]", "", s).strip().lower()
    return s2.startswith(("total", "subtotal", "grand total"))


def _reconcile_block(block: list[str]) -> list[str]:
    header = _split_row(block[0])
    ncol = len(header)
    rows = [_split_row(r) for r in block[2:]]
    rows = [r[:ncol] + [""] * (ncol - len(r)) for r in rows]
    total_cols = {c for c in range(ncol) if _is_total_label(header[c])}
    total_rows = {r for r in range(len(rows)) if rows[r] and _is_total_label(rows[r][0])}
    if not total_cols and not total_rows:
        return block
    value_cols = [c for c in range(1, ncol) if c not in total_cols]
    value_rows = [r for r in range(len(rows)) if r not in total_rows]
    parsed = [[_parse_num(rows[r][c]) for c in range(ncol)] for r in range(len(rows))]

    def fmt_for(r: int, c: int, val: float):
        # Match the style of the cells actually being summed: a total column's
        # cell follows its row's line items; a total row's cell follows its
        # column's line items. Add thousands separators for any value >= 1000.
        if c in total_cols:
            sibs = [_parse_num(rows[r][cc]) for cc in value_cols]
        else:
            sibs = [_parse_num(rows[rr][c]) for rr in value_rows]
        sibs = [s for s in sibs if s]
        pfx = "$" if any(p for _, p, _, _ in sibs) else ""
        com = any(cm for _, _, _, cm in sibs) or abs(val) >= 1000
        return pfx, com

    def set_cell(r: int, c: int, val: float):
        pfx, com = fmt_for(r, c, val)
        orig = parsed[r][c]  # keep the model's bold if it set it
        rows[r][c] = _fmt_num(val, pfx, bool(orig and orig[2]), com)

    # 1. total column(s) for each value row = sum of that row's value columns.
    for r in value_rows:
        for tc in total_cols:
            terms = [parsed[r][c][0] for c in value_cols if parsed[r][c]]
            if terms:
                set_cell(r, tc, sum(terms))
    # 2. total row(s): each value column = sum down the value rows. Skip text
    # columns (e.g. a "Justification" column has no numbers to sum).
    for tr in total_rows:
        for c in value_cols:
            terms = [parsed[r][c][0] for r in value_rows if parsed[r][c]]
            if terms:
                set_cell(tr, c, sum(terms))
    # 3. grand-total cell(s) = sum of the (now-correct) total row's value columns.
    for tr in total_rows:
        for tc in total_cols:
            terms = [_parse_num(rows[tr][c])[0] for c in value_cols if _parse_num(rows[tr][c])]
            if terms:
                set_cell(tr, tc, sum(terms))

    # Render compact GFM (no width padding — a wide text column would otherwise
    # bloat every cell). Markdown renders this identically.
    out = ["| " + " | ".join(header) + " |",
           "| " + " | ".join("---" for _ in range(ncol)) + " |"]
    for r in range(len(rows)):
        out.append("| " + " | ".join(rows[r]) + " |")
    return out


def reconcile_table_totals(text: str) -> str:
    """Make any 'Total'/'Subtotal' row or column in a Markdown table the exact
    arithmetic sum of its line items. A small on-device model reliably produces
    sensible per-line figures but cannot sum a column in its head; totals are
    *derived* values, so recomputing them — without altering any line item or the
    surrounding prose — keeps a budget/financial table internally consistent."""
    lines = text.split("\n")
    out: list[str] = []
    i, n = 0, len(lines)
    while i < n:
        is_header = lines[i].lstrip().startswith("|")
        is_sep = (i + 1 < n and "-" in lines[i + 1]
                  and re.fullmatch(r"\s*\|?[\s:\-|]+\|?\s*", lines[i + 1] or ""))
        if is_header and is_sep:
            j = i + 2
            while j < n and lines[j].lstrip().startswith("|"):
                j += 1
            out.extend(_reconcile_block(lines[i:j]))
            i = j
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def dedup_and_strip_tables(text: str) -> str:
    """Free-form table generation occasionally makes a small model repeat an
    entire table (sometimes with a few cells reworded) or trail off into a few
    orphan pipe-rows with no header. Keep the first well-formed table for any
    given header row and drop (a) later tables that repeat that header and
    (b) stray pipe-row fragments that aren't under a header+separator. This is
    structure-only cleanup — no cell content is altered — and a no-op on a body
    that already holds a single clean table or pure prose."""
    blocks = re.split(r"\n\s*\n", text)
    seen_headers: set = set()
    kept: list[str] = []
    for blk in blocks:
        nonempty = [l for l in blk.split("\n") if l.strip()]
        if not nonempty:
            continue
        # A table row either starts with "|" or carries >=2 pipes (multi-cell);
        # a prose sentence with a single stray "|" must NOT qualify, or we'd drop
        # real text.
        def is_row(l: str) -> bool:
            return "|" in l and (l.lstrip().startswith("|") or l.count("|") >= 2)
        rowish = [l for l in nonempty if is_row(l)]
        has_sep = any("-" in l and re.fullmatch(r"\s*\|?[\s:\-|]+\|?\s*", l)
                      for l in nonempty)
        # Only a block that is ENTIRELY table rows is treated as a table (or a
        # table fragment); a block with any prose line is left alone.
        if rowish and len(rowish) == len(nonempty):
            if not has_sep:
                # Orphan pipe-rows with no header/separator. Drop only what is
                # unambiguously a broken table fragment — a row that starts with
                # "|" or has an empty pipe-delimited cell (prose never does) — so
                # a multi-pipe prose line (e.g. "Options are A | B | C.") stays.
                if any(l.lstrip().startswith("|") for l in rowish) or any(
                        "" in _split_row(l) for l in rowish):
                    continue
            else:
                sig = tuple(c.lower() for c in _split_row(nonempty[0]))
                if sig in seen_headers:
                    continue  # a second table with the same header -> duplicate
                seen_headers.add(sig)
        kept.append(blk)
    return "\n\n".join(kept)


def extract_json(text: str) -> str:
    text = text.strip()
    # pull the first {...} or [...] block
    m = re.search(r"(\{.*\}|\[.*\])", text, re.DOTALL)
    return m.group(1) if m else text


def parse_json_loose(text: str) -> dict:
    """Parse model JSON, repairing the usual small-model defects."""
    raw = extract_json(text)
    raw = raw.replace("“", '"').replace("”", '"').replace("’", "'")
    raw = re.sub(r",\s*([}\]])", r"\1", raw)  # trailing commas
    # Repair unquoted numbers with thousands separators (e.g. 32,200 -> "32,200")
    # which small models emit despite the "strings only" instruction.
    raw = re.sub(r"(?<=[\[,]\s)(\d{1,3}(?:,\d{3})+(?:\.\d+)?)(?=\s*[,\]])",
                 lambda m: '"' + m.group(1) + '"', raw)
    return json.loads(raw)


def gen_structured(model: str, system: str, user: str, validate, *,
                   num_predict: int, attempts: int = 4,
                   response_format: dict | None = None) -> dict:
    """Generate + parse + validate structured JSON, retrying on bad shape.
    When `response_format` is given, the runtime constrains decoding to that
    JSON schema so output is syntactically valid by construction."""
    last_err = ""
    for i in range(attempts):
        # First pass at 0.3; retries drop to 0.2. For schema-constrained JSON we
        # want retries MORE deterministic (the first try's sampling produced an
        # invalid shape), the opposite of the usual "heat up on retry" pattern.
        raw = llm_generate(model, user, system, num_predict=num_predict,
                           temperature=0.2 if i else 0.3,
                           response_format=response_format)
        try:
            parsed = parse_json_loose(raw)
            ok, err = validate(parsed)
            if ok:
                return parsed
            last_err = err
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
        log(f"    ! structured output rejected (attempt {i+1}): {last_err}")
    raise RuntimeError(f"could not get valid structured output: {last_err}")


SYSTEM_DOC = (
    "You are Tessera, a local-first AI drafting assistant. You write a single "
    "section of a professional {role} document for {name} at {org}. Ground every "
    "claim strictly in the provided SOURCE FILES — do not invent facts, names, "
    "dates or numbers that are not supported by the sources. When you state a "
    "fact drawn from a source, cite it inline in square brackets with the source "
    "filename, e.g. [01-helpdesk-ticket-INC-4471.md]. Write in precise, neutral "
    "professional prose. State final figures and conclusions directly — do not "
    "show calculation scratch-work, walk through trial arithmetic, second-guess "
    "yourself, or speculate that the sources contain errors. Output only the "
    "section body in Markdown — do NOT repeat the section title, and do not add "
    "commentary before or after."
)


def gen_itemized_budget(persona: dict, sec: dict, corpus: str) -> str:
    """Generate a budget/financial table as constrained JSON, then render it
    deterministically. A small model reliably reports the source's per-line
    figures but, asked for a free-form table, tends to fabricate year-by-year
    columns the sources don't contain and ramble through invalid arithmetic.
    Pinning the shape to one amount + one justification per line item — and
    summing the Total ourselves — keeps the amounts and prose model-authored
    while making the structure and total deterministic and source-faithful."""
    title = sec["title"]
    sec_prompt = " ".join(sec["prompt"].split())
    system = (
        "You are Tessera, a local-first AI assistant. Produce an itemized budget "
        f"for a {persona['role']} at {persona['org']}, grounded STRICTLY in the "
        "SOURCE FILES. Output STRICT JSON only — no prose, no code fences. Schema: "
        "{\"unit\": string, \"period\": string, \"rows\": [{\"category\": string, "
        "\"amount\": number, \"justification\": string}]}. Use the exact budget "
        "categories and amounts stated in the source budget outline. Do NOT invent "
        "per-year splits, future-year projections, or figures the sources do not "
        "contain. Each amount is a single number in the unit the source uses (set "
        "\"unit\" to that, e.g. \"$000s\"). Each justification is ONE concise "
        "sentence stating WHAT the amount funds and WHY, grounded in the sources "
        "and citing the source file in square brackets, e.g. "
        "[01-program-notes-and-outcomes.md]. Do NOT show calculations, per-unit "
        "pricing, unit conversions, or arithmetic in the justification — state the "
        "rationale only."
    )
    user = (
        f"SOURCE FILES:\n{corpus}\n\n"
        f"SECTION TO WRITE: \"{title}\"\n"
        f"INSTRUCTION: {sec_prompt}\n\n"
        "Return ONLY the JSON object described in the schema."
    )

    def amount_of(r: dict):
        try:
            return float(str(r.get("amount")).replace(",", "").replace("$", ""))
        except (TypeError, ValueError):
            return None

    def validate(p: dict) -> tuple[bool, str]:
        rows = p.get("rows")
        if not isinstance(rows, list) or len(rows) < 3:
            return False, "need >=3 rows"
        for r in rows:
            if not isinstance(r, dict) or not str(r.get("category", "")).strip():
                return False, "every row needs a category"
            if amount_of(r) is None:
                return False, "every row needs a numeric amount"
        return True, ""

    schema = {
        "type": "json_schema",
        "json_schema": {
            "name": "budget",
            "schema": {
                "type": "object",
                "properties": {
                    "unit": {"type": "string"},
                    "period": {"type": "string"},
                    "rows": {
                        "type": "array", "minItems": 4,
                        "items": {
                            "type": "object",
                            "properties": {
                                "category": {"type": "string"},
                                "amount": {"type": "number"},
                                "justification": {"type": "string"},
                            },
                            "required": ["category", "amount", "justification"],
                        },
                    },
                },
                "required": ["unit", "rows"],
            },
        },
    }
    log("    - generating itemized budget JSON")
    parsed = gen_structured(persona["_model"], system, user, validate,
                            num_predict=1280, response_format=schema)

    def famt(v: float) -> str:
        return f"{int(v):,}" if float(v).is_integer() else f"{v:,.2f}"

    unit = str(parsed.get("unit") or "$").strip()
    rows, total = [], 0.0
    for r in parsed["rows"]:
        amt = amount_of(r) if isinstance(r, dict) else None
        if amt is None or not str(r.get("category", "")).strip():
            continue
        just = " ".join(str(r.get("justification", "")).split())  # one table-cell line
        rows.append((str(r["category"]).strip(), amt, just))
        total += amt
    lines = [f"| Category | Amount ({unit}) | Justification |", "| --- | --- | --- |"]
    lines += [f"| {cat} | {famt(amt)} | {just} |" for cat, amt, just in rows]
    lines.append(f"| **Total** | **{famt(total)}** | |")
    body = "\n".join(lines)
    period = str(parsed.get("period") or "").strip()
    return f"Itemized budget ({period}):\n\n{body}" if period else body


def gen_document(persona: dict, template: dict, corpus: str, source_names: list[str],
                 prompt_log: list[str]) -> tuple[str, int]:
    system = SYSTEM_DOC.format(role=persona["role"], name=persona["name"], org=persona["org"])
    parts: list[str] = [f"# {template['name']}\n"]
    citations: set[str] = set()
    sections = template.get("sections", [])
    for i, sec in enumerate(sections, 1):
        title = sec["title"]
        sec_prompt = " ".join(sec["prompt"].split())
        fmt = sec.get("output_format")
        fmt_hint = {
            "numbered_list": "Format the body as a numbered list.",
            "bullets": "Format the body as a bulleted list.",
            "table": (
                "Format the body as a GitHub-flavored Markdown table. Every "
                "numeric column header must state its unit explicitly (e.g. a "
                "money column reads \"FY2025 ($)\" or \"Annual ($)\" — never an "
                "ambiguous or wrong unit like \"(Months)\" on a dollar column). "
                "Only include columns/periods the SOURCE FILES actually support — "
                "if the sources give a single budget or total (not a year-by-year "
                "breakdown), use one amount column rather than inventing per-year "
                "figures. Keep units consistent down each column and keep every "
                "figure realistic and grounded in the SOURCE FILES (do not "
                "multiply line items into implausible totals). If the table "
                "includes a row or column that sums the others, label it exactly "
                "\"Total\" (not "
                "\"Amount\"/\"Sum\"/\"Cost\"), and make sure every total, subtotal, "
                "or derived figure is arithmetically consistent with the line "
                "items it summarizes."
            ),
        }.get(fmt, "Write 1-3 tight paragraphs.")
        user = (
            f"SOURCE FILES:\n{corpus}\n\n"
            f"SECTION TO WRITE: \"{title}\"\n"
            f"INSTRUCTION: {sec_prompt}\n\n"
            f"{fmt_hint}"
        )
        log(f"    - [{i}/{len(sections)}] {title}")
        is_budget = fmt == "table" and "budget" in title.lower()
        if is_budget:
            # Budget/financial tables go through constrained-JSON generation so
            # the model can't fabricate year-by-year columns or non-summing
            # totals; the structure + Total are rendered deterministically.
            body, finish = gen_itemized_budget(persona, sec, corpus), "stop"
        else:
            # A table section packs many line items plus a written justification
            # for each, so it needs more room than a prose section to finish
            # without truncating mid-table.
            sec_budget = 1280 if fmt == "table" else 768
            raw, finish = llm_complete(persona["_model"], user, system,
                                       num_predict=sec_budget, temperature=0.4)
            body = clean(raw)
            body = strip_echoed_title(body, title)
        body = normalize_citations(body)
        # If the model hit the token budget mid-sentence, drop the dangling
        # fragment so the section reads as finished, not cut off.
        if finish == "length":
            body = trim_dangling_sentence(body)
        if is_budget:
            # gen_itemized_budget already rendered a single table with a
            # deterministic, correct Total — no dedup or reconcile needed.
            pass
        else:
            # Free-form table output can repeat a table or trail into orphan
            # pipe-rows; collapse it back to one clean table first.
            body = dedup_and_strip_tables(body)
            # Totals in a generated table are derived values the small model
            # can't sum reliably; recompute any Total/Subtotal row or column
            # from its line items so a financial table is internally consistent.
            body = reconcile_table_totals(body)
        for n in source_names:
            if f"[{n}]" in body:
                citations.add(n)
        parts.append(f"## {title}\n\n{body}\n")
        prompt_log.append(
            f"### Section {i}: {title}\n\n"
            f"**Template section prompt (verbatim from `{template['_path']}`):**\n\n"
            f"> {sec_prompt}\n\n"
            + (f"**Output format:** `{fmt}`\n\n" if fmt else "")
        )
    return "\n".join(parts), len(citations)


def gen_sheet(persona: dict, template: dict, corpus: str, source_names: list[str],
              prompt_log: list[str], hint: str = "") -> tuple[str, int]:
    # Derive intended columns from the template's section titles / description.
    sec_titles = [s["title"] for s in template.get("sections", [])]
    guidance = template.get("description", "")
    system = (
        "You are Tessera, a local-first AI assistant generating a spreadsheet for "
        f"a {persona['role']} at {persona['org']}. Output STRICT JSON only, no prose, "
        "no code fences. Schema: {\"columns\": string[], \"rows\": string[][]}. "
        "The columns array holds the header labels; each row is the DATA only — do NOT "
        "emit a row that repeats the headers or names template sections. Every row must "
        "have exactly as many cells as there are columns. EVERY cell must be a quoted "
        "string; never write a bare number, and never use thousands separators (write "
        "\"32200\" or \"$32.2M\", not 32,200). Ground all values strictly in the SOURCE "
        "FILES; do not invent figures not supported by them."
    )
    structure = hint if hint else (
        f"Suggested structure / sections: {sec_titles}. Use a clear label column first, "
        "then well-typed data columns."
    )
    user = (
        f"SOURCE FILES:\n{corpus}\n\n"
        f"Build a spreadsheet titled \"{template['name']}\". "
        f"It should cover: {guidance}. {structure} "
        "Produce 8-14 well-populated data rows (no header row in `rows`). Numbers should "
        "be realistic and internally consistent (totals add up). Return ONLY the JSON object."
    )
    def validate(p: dict) -> tuple[bool, str]:
        if not isinstance(p.get("columns"), list) or len(p["columns"]) < 2:
            return False, "need >=2 columns"
        rows = p.get("rows")
        if not isinstance(rows, list) or len(rows) < 4:
            return False, "need >=4 rows"
        if not all(isinstance(r, list) for r in rows):
            return False, "each row must be an array (got a string)"
        return True, ""
    sheet_schema = {
        "type": "json_schema",
        "json_schema": {
            "name": "sheet",
            "schema": {
                "type": "object",
                "properties": {
                    "columns": {"type": "array", "minItems": 2,
                                "items": {"type": "string"}},
                    "rows": {"type": "array", "minItems": 8,
                             "items": {"type": "array", "items": {"type": "string"}}},
                },
                "required": ["columns", "rows"],
            },
        },
    }
    # NOTE: when the runtime supports constrained decoding this schema is the
    # binding constraint (minItems 8 rows here). validate() below intentionally
    # uses a looser floor (>= 4 rows) so it still passes as a fallback on a
    # runtime that ignores response_format; the stricter schema wins whenever
    # it is honored.
    log("    - generating sheet JSON")
    parsed = gen_structured(persona["_model"], system, user, validate,
                            num_predict=1800, response_format=sheet_schema)
    cols = [str(c) for c in parsed["columns"]]
    rows = [[str(c) for c in r][: len(cols)] + [""] * (len(cols) - len(r))
            for r in parsed["rows"] if isinstance(r, list)]
    content = json.dumps({"columns": cols, "rows": rows})
    prompt_log.append(
        f"### Spreadsheet generation\n\n"
        f"**Template:** `{template['_path']}` — {template['name']}\n\n"
        f"**Template sections:** {sec_titles}\n\n"
        f"**Instruction:** {guidance}\n\n"
        + (f"**Structure hint:** {hint}\n" if hint else "")
    )
    return content, 0


def gen_base(persona: dict, template: dict, corpus: str, source_names: list[str],
             prompt_log: list[str], hint: str = "") -> tuple[str, int]:
    sec_titles = [s["title"] for s in template.get("sections", [])]
    guidance = template.get("description", "")
    system = (
        "You are Tessera, a local-first AI assistant generating a structured database "
        f"(a 'base') for a {persona['role']} at {persona['org']}. Output STRICT JSON only, "
        "no prose, no code fences. Schema: {\"fields\":[{\"name\":string,\"type\":\"text\"|"
        "\"number\"|\"select\"|\"date\"}], \"records\":[{<FieldName>:value, ...}]}. "
        "Every record must use the exact field names declared in fields and populate EVERY "
        "field with a real value drawn from the sources (no empty strings, no 'None' "
        "placeholders). Ground all values strictly in the SOURCE FILES."
    )
    structure = hint if hint else f"Suggested columns/sections: {sec_titles}."
    user = (
        f"SOURCE FILES:\n{corpus}\n\n"
        f"Build a structured base titled \"{template['name']}\". "
        f"Purpose: {guidance}. {structure} "
        "Define 5-8 fields and produce 6-12 fully-populated records. Return ONLY the JSON object."
    )
    def validate(p: dict) -> tuple[bool, str]:
        if not isinstance(p.get("fields"), list) or len(p["fields"]) < 3:
            return False, "need >=3 fields"
        recs = p.get("records")
        if not isinstance(recs, list) or len(recs) < 4:
            return False, "need >=4 records"
        if not all(isinstance(r, dict) for r in recs):
            return False, "each record must be an object"
        return True, ""
    base_schema = {
        "type": "json_schema",
        "json_schema": {
            "name": "base",
            "schema": {
                "type": "object",
                "properties": {
                    "fields": {
                        "type": "array", "minItems": 5,
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "type": {"type": "string",
                                         "enum": ["text", "number", "select", "date"]},
                            },
                            "required": ["name", "type"],
                        },
                    },
                    # Records carry dynamic (per-field) keys, so the schema
                    # enforces "non-empty array of objects"; field population
                    # is checked by validate() + the retry loop.
                    "records": {"type": "array", "minItems": 6,
                                "items": {"type": "object"}},
                },
                "required": ["fields", "records"],
            },
        },
    }
    # As with the sheet schema: under constrained decoding these minItems
    # (>= 5 fields, >= 6 records) are binding. validate() keeps a looser floor
    # so generation still passes on a runtime that ignores response_format; the
    # stricter schema wins whenever it is honored.
    log("    - generating base JSON")
    parsed = gen_structured(persona["_model"], system, user, validate,
                            num_predict=2400, response_format=base_schema)
    fields = []
    for f in parsed["fields"]:
        if isinstance(f, dict) and f.get("name"):
            t = f.get("type", "text")
            t = t if t in ("text", "number", "select", "date") else "text"
            fields.append({"name": str(f["name"]), "type": t})
    field_names = [f["name"] for f in fields]
    records = []
    for r in parsed.get("records", []):
        if isinstance(r, dict):
            rec = {fn: str(r.get(fn, "")) for fn in field_names}
            records.append(rec)
    # Derive `options` for select fields from the distinct values actually used
    # across records, so the Grid/Kanban/Form views render the chosen value
    # instead of an empty dropdown.
    for f in fields:
        if f["type"] == "select":
            seen: list[str] = []
            for rec in records:
                v = rec.get(f["name"], "").strip()
                if v and v not in seen:
                    seen.append(v)
            if seen:
                f["options"] = seen
    content = json.dumps({"fields": fields, "records": records})
    prompt_log.append(
        f"### Base generation\n\n"
        f"**Template:** `{template['_path']}` — {template['name']}\n\n"
        f"**Purpose:** {guidance}\n\n"
        f"**Template sections:** {sec_titles}\n\n"
        + (f"**Structure hint:** {hint}\n" if hint else "")
    )
    return content, 0


def gen_slides(persona: dict, template: dict, corpus: str, source_names: list[str],
               prompt_log: list[str]) -> tuple[str, int]:
    sections = template.get("sections", [])
    system = (
        "You are Tessera, a local-first AI assistant writing ONE presentation slide for "
        f"a {persona['role']} at {persona['org']}. Output 3-5 concise bullet points (one per "
        "line, starting with '- '). Ground every point strictly in the SOURCE FILES; cite the "
        "source filename in [brackets] where a point relies on it. No title, no commentary."
    )
    slides = []
    for i, sec in enumerate(sections, 1):
        title = sec["title"]
        sec_prompt = " ".join(sec["prompt"].split())
        user = (f"SOURCE FILES:\n{corpus}\n\nSLIDE: \"{title}\"\nINSTRUCTION: {sec_prompt}\n\n"
                "Write the slide body as 3-5 bullet points.")
        log(f"    - slide [{i}/{len(sections)}] {title}")
        raw, finish = llm_complete(persona["_model"], user, system,
                                   num_predict=300, temperature=0.45)
        body = clean(raw)
        body = strip_echoed_title(body, title)
        body = normalize_citations(body)
        # Same treatment as document sections: if the slide hit the token
        # budget mid-sentence, drop the dangling fragment so the bullet list
        # reads as finished rather than cut off.
        if finish == "length":
            body = trim_dangling_sentence(body)
        slides.append({
            "id": f"slide-{i}",
            "title": title,
            "blocks": [{"id": f"slide-{i}-b1", "type": "text", "content": body}],
            "notes": "",
        })
        prompt_log.append(
            f"### Slide {i}: {title}\n\n"
            f"**Template section prompt (verbatim from `{template['_path']}`):**\n\n"
            f"> {sec_prompt}\n"
        )
    content = json.dumps({"slides": slides, "marp": {"enabled": False, "source": "", "theme": "default"}})
    return content, 0


GENERATORS = {
    "document": gen_document,
    "sheet": gen_sheet,
    "base": gen_base,
    "slides": gen_slides,
}


def to_editor_content(art_type: str, content: str) -> str:
    """Convert on-disk artifact content into the exact string the matching
    Tessera editor persists. Documents are stored as Markdown on disk (matching
    the bridge's `## section` output) but the TipTap document editor's persisted
    form is HTML (its `getHTML()` round-trip), so we render Markdown -> HTML for
    the dataset. Sheets/bases/slides are already the JSON their editors parse."""
    if art_type != "document":
        return content
    import markdown as _md
    return _md.markdown(
        content,
        extensions=["tables", "fenced_code", "sane_lists", "nl2br"],
    )


def editor_content(art_type: str, raw_content: str, slug: str) -> str:
    """Editor-persisted content for the renderer dataset: convert the on-disk
    artifact to its editor form (Markdown -> HTML for documents) and then apply
    the deterministic structural enrichment so the showcase exercises the
    shipped editor capabilities (callout/toggle/TOC, sheet formulas/charts,
    multi-table linked bases, slide layouts/themes/notes)."""
    return enrich.enrich(art_type, to_editor_content(art_type, raw_content), slug)


def showcase_ext(art_type: str) -> str:
    """On-disk extension for the inspectable ENRICHED artifact: documents are
    persisted as HTML by the editor, everything else as JSON."""
    return "html" if art_type == "document" else "json"


def preview_markdown(art_type: str, title: str, content: str) -> str:
    if art_type == "document":
        return content
    if art_type == "sheet":
        d = json.loads(content)
        cols, rows = d["columns"], d["rows"]
        out = [f"# {title}\n", "| " + " | ".join(cols) + " |",
               "|" + "|".join(["---"] * len(cols)) + "|"]
        for r in rows:
            out.append("| " + " | ".join(r) + " |")
        return "\n".join(out)
    if art_type == "base":
        d = json.loads(content)
        fields = [f["name"] for f in d["fields"]]
        out = [f"# {title}\n",
               "| " + " | ".join(f"{f['name']} ({f['type']})" for f in d["fields"]) + " |",
               "|" + "|".join(["---"] * len(fields)) + "|"]
        for rec in d["records"]:
            out.append("| " + " | ".join(str(rec.get(fn, "")) for fn in fields) + " |")
        return "\n".join(out)
    if art_type == "slides":
        d = json.loads(content)
        out = [f"# {title}\n"]
        for s in d["slides"]:
            out.append(f"## {s['title']}\n")
            for b in s["blocks"]:
                out.append(b["content"] + "\n")
            out.append("---\n")
        return "\n".join(out)
    return content


def ts_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")


def main() -> None:
    # Arg forms:
    #   ""                  → (re)generate everything via the on-device runtime
    #   "<persona>"         → regenerate one whole persona
    #   "<persona>:<slug>"  → regenerate one artifact, load the rest from disk
    #   "--reuse"           → re-emit ALL datasets from the committed genuine
    #                         outputs/ (no runtime needed): reapply the
    #                         deterministic enrichment + rebuild the .ts modules.
    #                         Used to refresh the renderer datasets / enriched
    #                         artifacts after an enrichment change without
    #                         re-running the model.
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    reuse = arg in ("--reuse", "--from-disk")
    only_pid = only_slug = None
    if arg and not reuse:
        only_pid, _, only_slug = arg.partition(":")
        only_slug = only_slug or None
    manifest = yaml.safe_load(MANIFEST.read_text())
    model = manifest["model"]
    # Guard: the configured model MUST be a Tessera design text model.
    spec = assert_design_model(model)
    # Registry entries always carry these today; fall back defensively so a
    # future text model that omits an optional field can't crash the generator.
    spec_name = spec.get("name", model)
    spec_fmt = (spec.get("format") or "gguf").upper()
    spec_quant = spec.get("quantization") or "unknown"
    model_label = (
        f"{spec_name} ({spec_fmt} {spec_quant}) "
        f"— `{model}`, via the PrismML llama.cpp `llama-server` (Tessera's "
        f"on-device runtime)"
    )
    log(f"Model (design-validated): {model_label}")
    for persona in manifest["personas"]:
        if only_pid and persona["id"] != only_pid:
            continue
        persona["_model"] = model
        pid = persona["id"]
        log(f"\n=== Persona: {pid} ({persona['role']}) ===")
        corpus, source_names = load_inputs(pid)
        dataset_artifacts = []
        for art in persona["artifacts"]:
            tmpl_path = REPO / art["template"]
            template = yaml.safe_load(tmpl_path.read_text())
            template["_path"] = art["template"]
            out_dir = REPO / "docs/showcase/artifacts" / pid / "outputs"
            ext = "md" if art["type"] == "document" else "json"
            if reuse or (only_slug and art["slug"] != only_slug):
                # Re-emit from the committed genuine output on disk (reuse
                # mode, or preserving the other artifacts of a single-slug
                # regen). No runtime call; reapply the deterministic enrichment.
                existing = (out_dir / f"{art['slug']}.{ext}").read_text()
                cc = sum(1 for n in source_names if f"[{n}]" in existing) \
                    if art["type"] == "document" else 0
                enriched = editor_content(art["type"], existing, art["slug"])
                (out_dir / f"{art['slug']}.showcase.{showcase_ext(art['type'])}").write_text(enriched)
                dataset_artifacts.append({
                    "slug": art["slug"], "title": art["title"], "type": art["type"],
                    "templateId": template.get("id"), "templateName": template["name"],
                    "content": enriched, "citationCount": cc,
                })
                log(f"  Artifact: {art['slug']} ({art['type']}) <- enriched from disk")
                continue
            log(f"  Artifact: {art['slug']} ({art['type']}) <- {template['name']}")
            prompt_log: list[str] = [
                f"# Prompt log — {art['title']}\n",
                f"- **Persona:** {persona['name']}, {persona['role']}, {persona['org']}",
                f"- **Template:** `{art['template']}` ({template['name']})",
                f"- **Model:** {model_label}",
                f"- **Input source files:** {', '.join(source_names)}\n",
                "Tessera runs each template section prompt below against the source "
                "files, grounded locally. The generated output is in the matching "
                "`outputs/` file.\n",
            ]
            gen = GENERATORS[art["type"]]
            if art["type"] in ("sheet", "base"):
                content, citation_count = gen(persona, template, corpus, source_names,
                                              prompt_log, art.get("hint", ""))
            else:
                content, citation_count = gen(persona, template, corpus, source_names, prompt_log)

            prm_dir = REPO / "docs/showcase/artifacts" / pid / "prompts"
            # Self-contained: a brand-new persona has no committed dirs yet.
            out_dir.mkdir(parents=True, exist_ok=True)
            prm_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / f"{art['slug']}.{ext}").write_text(content)
            (out_dir / f"{art['slug']}.preview.md").write_text(
                preview_markdown(art["type"], art["title"], content))
            (prm_dir / f"{art['slug']}.md").write_text("\n".join(prompt_log))
            enriched = editor_content(art["type"], content, art["slug"])
            (out_dir / f"{art['slug']}.showcase.{showcase_ext(art['type'])}").write_text(enriched)

            dataset_artifacts.append({
                "slug": art["slug"], "title": art["title"], "type": art["type"],
                "templateId": template.get("id"), "templateName": template["name"],
                "content": enriched, "citationCount": citation_count,
            })
            log(f"    -> wrote outputs/{art['slug']}.{ext} (citations: {citation_count})")

        # Emit renderer dataset module for this persona.
        ds_path = REPO / "apps/desktop/renderer/src/showcase/generated" / f"{pid}.ts"
        lines = [
            "// AUTO-GENERATED by scripts/showcase/generate.py — do not edit by hand.",
            "// Genuine local-LLM output used to populate the showcase mock bridge.",
            "import type { ShowcaseDataset } from \"../types\";", "",
            f"export const {pid}Dataset: ShowcaseDataset = {{",
            f"  id: {json.dumps(pid)},",
            f"  persona: {json.dumps({k: persona[k] for k in ('name','role','org','market','blurb')})},",
            "  sourceFiles: [" + ", ".join(json.dumps(n) for n in source_names) + "],",
            "  artifacts: [",
        ]
        for a in dataset_artifacts:
            lines.append("    {")
            lines.append(f"      slug: {json.dumps(a['slug'])},")
            lines.append(f"      title: {json.dumps(a['title'])},")
            lines.append(f"      type: {json.dumps(a['type'])},")
            lines.append(f"      templateId: {json.dumps(a['templateId'])},")
            lines.append(f"      templateName: {json.dumps(a['templateName'])},")
            lines.append(f"      citationCount: {a['citationCount']},")
            lines.append(f"      content: `{ts_escape(a['content'])}`,")
            lines.append("    },")
        lines += ["  ],", "};", ""]
        ds_path.write_text("\n".join(lines))
        log(f"  -> dataset apps/desktop/renderer/src/showcase/generated/{pid}.ts")


if __name__ == "__main__":
    main()
