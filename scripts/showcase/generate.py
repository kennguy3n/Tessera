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
    # 5. bare parenthesized filename:  (file) -> [file]
    text = re.sub(r"\(\s*" + FILE + r"\s*\)", r"[\1]", text)
    # 6. collapse any residual parens left around an already-bracketed file:
    #    ([file]) -> [file]
    text = re.sub(r"\(\s*(\[" + FILE + r"\])\s*\)", r"\1", text)
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
    "professional prose. Output only the section body in Markdown — do NOT repeat "
    "the section title, and do not add commentary before or after."
)


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
            "table": "Format the body as a GitHub-flavored Markdown table.",
        }.get(fmt, "Write 1-3 tight paragraphs.")
        user = (
            f"SOURCE FILES:\n{corpus}\n\n"
            f"SECTION TO WRITE: \"{title}\"\n"
            f"INSTRUCTION: {sec_prompt}\n\n"
            f"{fmt_hint}"
        )
        log(f"    - [{i}/{len(sections)}] {title}")
        raw, finish = llm_complete(persona["_model"], user, system,
                                   num_predict=768, temperature=0.4)
        body = clean(raw)
        body = strip_echoed_title(body, title)
        body = normalize_citations(body)
        # If the model hit the token budget mid-sentence, drop the dangling
        # fragment so the section reads as finished, not cut off.
        if finish == "length":
            body = trim_dangling_sentence(body)
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
    # Arg forms: "" (all), "<persona>" (whole persona), "<persona>:<slug>"
    # (regenerate only that artifact, load the rest from disk).
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    only_pid = only_slug = None
    if arg:
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
            if only_slug and art["slug"] != only_slug:
                # Preserve a previously-generated artifact: load it from disk.
                existing = (out_dir / f"{art['slug']}.{ext}").read_text()
                cc = sum(1 for n in source_names if f"[{n}]" in existing) \
                    if art["type"] == "document" else 0
                dataset_artifacts.append({
                    "slug": art["slug"], "title": art["title"], "type": art["type"],
                    "templateId": template.get("id"), "templateName": template["name"],
                    "content": to_editor_content(art["type"], existing), "citationCount": cc,
                })
                log(f"  Artifact: {art['slug']} ({art['type']}) <- kept existing on disk")
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

            dataset_artifacts.append({
                "slug": art["slug"], "title": art["title"], "type": art["type"],
                "templateId": template.get("id"), "templateName": template["name"],
                "content": to_editor_content(art["type"], content), "citationCount": citation_count,
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
