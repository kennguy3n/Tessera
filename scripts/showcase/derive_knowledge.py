#!/usr/bin/env python3
"""
Showcase knowledge-plane derivation.

The knowledge substrate (the `knowledge` crate's observation_engine +
concept_graph) extracts, from indexed source content:
  * Entities  — capitalised tokens / proper nouns / @-mentions, identifier
                codes, regulatory refs.
  * Decisions — sentences carrying decision keywords (decided / approved /
                agreed / recommend / selected …).
  * Tasks     — sentences carrying TODO / ACTION / please / imperative leads.
  * Questions — interrogative sentences.
  * Facts     — declarative sentences that are none of the above.
  * Concepts  — concept-graph nodes built from Entity observations, linked to
                every source they co-occur in.

This script reproduces those exact classification rules (see
`crates/observation_engine/src/extractor.rs` in the knowledge dependency) and
runs them deterministically over the persona's GENUINE indexed source files
(`docs/showcase/artifacts/<id>/inputs/*.md`) — exactly the content the real
substrate would extract observations from. Every fact, entity, and concept is
therefore traceable to a real source file — nothing here is hand-authored.

Output: `apps/desktop/renderer/src/showcase/generated/<id>.knowledge.ts`
exporting a `ShowcaseKnowledgePlane`, loaded by the mock bridge so the live
renderer's enriched "Knowledge" tab renders real, traceable data.

Run:  python3 scripts/showcase/derive_knowledge.py
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import OrderedDict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARTIFACTS = REPO / "docs/showcase/artifacts"
OUT_DIR = REPO / "apps/desktop/renderer/src/showcase/generated"

PERSONAS = ["healthcare", "legal", "finance", "nonprofit", "retail"]

# Deterministic "now" matching the rest of the showcase (NOW in index.ts =
# 2026-05-12T15:04:00Z). Memory timestamps are expressed in epoch seconds.
NOW_S = 1778598240  # 2026-05-12T15:04:00Z == Date.parse(NOW)/1000 in index.ts (seconds, not ms)

# Mirror of the engine's sentence-class keyword tables (English default set).
DECISION_KW = re.compile(
    r"\b(decided|agreed|approved|recommend(?:s|ed|ation)?|selected|chose|"
    r"will|must|should|classif\w+|escalat\w+|prioriti[sz]\w+)\b",
    re.I,
)
TASK_KW = re.compile(r"\b(todo|action|task|please|follow[- ]up|need to|require[ds]?)\b", re.I)

STOPWORDS = {
    "The", "This", "That", "These", "Those", "Their", "There", "Then", "They",
    "A", "An", "And", "But", "For", "Per", "Total", "Net", "Key", "New", "Top",
    "While", "When", "With", "From", "Each", "All", "No", "Not", "Due",
    "Q1", "Q2", "Q3", "Q4", "FY25", "FY26",
}

# Identifier / regulatory patterns the engine treats as high-salience entities.
# Codes must be hyphenated or contiguous (e.g. INC-4471, FY2025) so a metric
# followed by a value ("DSCR 1.45x") is NOT mistaken for an "DSCR 1" id.
ID_RE = re.compile(r"\b(?:[A-Z]{2,}-?\d[\w-]*|\d+\s?CFR\s?§?\s?[\d.]+|§\s?[\d.]+[a-z]?)\b")
# Capitalised multi-word proper-noun phrases (people, orgs, projects).
PROPER_RE = re.compile(r"\b([A-Z][a-zA-Z0-9&.]+(?:\s+[A-Z][a-zA-Z0-9&.]+){0,3})\b")


def uid(*parts: str) -> str:
    """Stable UUID-shaped id from inputs so reruns are byte-identical."""
    h = hashlib.sha1("::".join(parts).encode()).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def source_id(persona: str, filename: str) -> str:
    num = filename.split("-", 1)[0]
    return f"sc-{persona}-src-{num}"


def md_to_text(line: str) -> str:
    """Strip markdown decoration from one line, leaving plain running text."""
    line = line.strip()
    if line.startswith("|"):  # table row -> join cells as a clause
        cells = [c.strip() for c in line.strip("|").split("|")]
        cells = [c for c in cells if c and not set(c) <= {"-", ":", " "}]
        line = ": ".join(cells)
    line = line.lstrip("#-*> ").strip()
    line = re.sub(r"\*\*(.+?)\*\*", r"\1", line)
    line = re.sub(r"[*_`]", "", line)
    return re.sub(r"\s+", " ", line).strip()


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p.strip() for p in parts if len(p.strip()) > 3]


def clean(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    stripped = text.rstrip(" ,;:")
    return stripped if (stripped and stripped[-1] in ".!?") else stripped + "."


# Generic capitalised words that are not real named entities.
DENY_WORDS = {
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December",
    "America", "Chicago", "Excel", "Assigned", "Opened", "Reported", "Description",
    "Asset", "Status", "Priority", "Summary", "Overview", "Notes", "Context",
    "Customer", "Provider", "Vendor", "Agreement", "Section", "Exhibit",
    "Liability", "Effective", "America/Chicago", "RN", "Floor", "Term", "Fees",
    "Payment", "Data", "Service", "Levels", "Protection", "Renewal", "Email",
    "Laptop", "Dell", "Inc", "LLP", "Co", "Corp",
}

# Salience signals for facts: quantities, dates, money, obligations.
NUM_RE = re.compile(r"\d")
MONEY_PCT_RE = re.compile(r"[$£€%]|\b\d+(?:\.\d+)?\s?(?:%|days?|months?|hours?|bps|FTE)\b", re.I)
OBLIGATION_RE = re.compile(
    r"\b(within|no later than|shall|must|will|net \d|uptime|breach|notify|"
    r"liabilit\w+|renew\w+|terminat\w+|deadline|due|exceed|cap(?:ped)?|"
    r"credit|fee|rate|margin|ratio|covenant|approv\w+|recommend\w+)\b",
    re.I,
)


def is_label_noise(text: str) -> bool:
    t = text.strip()
    if t.endswith("(excerpts).") or "verbatim" in t.lower():
        return True
    # "Label: value" with a substantive (numeric / multi-word) value is fine;
    # a bare "Word." or "Two Words." with no verb and no number is noise.
    if ":" not in t and not NUM_RE.search(t) and len(t.split()) <= 4:
        return True
    return False


def salience(text: str, typ: str) -> int:
    score = 0
    if typ == "decision":
        score += 2
    if typ == "task":
        score += 1
    if NUM_RE.search(text):
        score += 1
    if MONEY_PCT_RE.search(text):
        score += 2
    if OBLIGATION_RE.search(text):
        score += 2
    # Reward a real clause (has a lowercase verb-ish token), penalise fragments.
    if re.search(r"\b[a-z]{3,}(?:s|ed|es|ing)\b", text):
        score += 1
    return score


def is_entity(ent: str) -> bool:
    ent = ent.strip()
    # A word (>=2 letters) followed by a period is a sentence-split fragment
    # ("May. Activities"); single-letter initials ("A. Okafor") are kept.
    if re.search(r"\b[A-Za-z]{2,}\.", ent):
        return False
    if ID_RE.fullmatch(ent) or ent.startswith("§") or "CFR" in ent:
        # Identifier codes / regulatory refs are always salient. This path
        # intentionally OVERRIDES STOPWORDS — a code like FY25/FY26 is filtered
        # from the proper-noun path but kept here as a tracked identifier.
        return True
    words = ent.split()
    if len(words) < 2:
        return False  # drop single generic capitalised words
    if words[0] in DENY_WORDS or words[0] in STOPWORDS:
        return False
    if all(w in DENY_WORDS or w in STOPWORDS for w in words):
        return False
    return True


def classify(sentence: str) -> str:
    s = sentence.strip()
    if s.endswith("?"):
        return "question"
    if TASK_KW.search(s):
        return "task"
    if DECISION_KW.search(s):
        return "decision"
    return "fact"


def state_for(corroboration: int, pins: int) -> tuple[str, float]:
    """Mirror MemoryState progression. `corroboration` is a source-count proxy
    (the number of distinct source files an observation appears in), not a count
    of independent corroboration events; more sources / pins => further along the
    candidate->canonical path with a higher retention score."""
    if pins > 0:
        return "reinforced", min(0.97, 0.88 + 0.03 * corroboration)
    if corroboration >= 3:
        return "canonical", min(0.95, 0.84 + 0.03 * corroboration)
    if corroboration == 2:
        return "consolidated", 0.78
    return "candidate", 0.62


def derive(persona: str) -> dict:
    in_dir = ARTIFACTS / persona / "inputs"
    inputs = sorted(in_dir.glob("*.md"))

    # Observations are extracted per indexed source file, mirroring the real
    # pipeline (observation_engine runs over source chunks).
    sentence_rows: list[tuple[str, str, str]] = []  # (clean_text, type, source_file)
    entity_sources: "OrderedDict[str, set]" = OrderedDict()
    entity_first_sentence: dict[str, str] = {}

    for src in inputs:
        fname = src.name
        raw = src.read_text(encoding="utf-8")
        for rawline in raw.splitlines():
            line = md_to_text(rawline)
            if len(line) < 12:
                continue
            for sent in split_sentences(line):
                text = clean(sent)
                if len(text) < 25 or len(text) > 240:
                    continue
                sentence_rows.append((text, classify(sent), fname))
            # Entity extraction spans the whole source line.
            for m in ID_RE.findall(line):
                ent = m.strip()
                entity_sources.setdefault(ent, set()).add(fname)
                entity_first_sentence.setdefault(ent, clean(line)[:160])
            for m in PROPER_RE.findall(line):
                ent = m.strip()
                if ent in STOPWORDS or len(ent) < 4 or (ent.isupper() and len(ent) < 3):
                    continue
                if all(w in STOPWORDS for w in ent.split()):
                    continue
                entity_sources.setdefault(ent, set()).add(fname)
                entity_first_sentence.setdefault(ent, clean(line)[:160])

    # ---- Facts / decisions (salience-ranked) ----
    # A high-signal observation carries a quantity / date / obligation, not a
    # bare section label. Score each candidate and keep the strongest.
    fact_counter: "OrderedDict[str, dict]" = OrderedDict()
    for text, typ, src in sentence_rows:
        if typ not in ("fact", "decision", "task"):
            continue
        if is_label_noise(text):
            continue
        sal = salience(text, typ)
        if sal <= 0:
            continue
        key = text.lower()[:80]
        row = fact_counter.get(key)
        if row is None:
            fact_counter[key] = {"text": text, "type": typ, "srcs": {src}, "sal": sal}
        else:
            row["srcs"].add(src)
            row["sal"] = max(row["sal"], sal)

    ranked_facts = sorted(
        fact_counter.values(),
        key=lambda r: (-(len(r["srcs"]) - 1), -r["sal"], r["text"]),
    )[:10]

    facts: list[dict] = []
    for i, row in enumerate(ranked_facts):
        corro = len(row["srcs"])
        pins = 1 if i == 0 else 0  # the lead observation is pinned in the demo
        state, retention = state_for(corro, pins)
        facts.append({
            "id": uid(persona, "mem", row["text"]),
            "scopeId": f"sc-{persona}-scope",
            "observationType": row["type"],
            "content": row["text"],
            "state": state,
            "retentionScore": round(retention, 2),
            "pinCount": pins,
            "retrievalCount": max(0, 6 - i),
            "corroborationCount": corro,
            "createdAt": NOW_S - 86400 * (i + 1),
            "lastAccessedAt": NOW_S - 3600 * (i + 1),
            "sourceId": source_id(persona, sorted(row["srcs"])[0]),
        })

    # ---- Entities: keep only salient ID codes, §-refs, and multi-word proper
    # nouns (orgs / people / defined terms). Single generic capitalised words
    # (calendar names, "America", "Excel", …) are dropped. ----
    accepted = OrderedDict(
        (ent, srcs) for ent, srcs in entity_sources.items() if is_entity(ent)
    )
    ranked = sorted(
        accepted.items(),
        key=lambda kv: (-len(kv[1]), -(1 if ID_RE.fullmatch(kv[0]) else 0), kv[0]),
    )
    ent_items: list[dict] = []
    for i, (ent, srcs) in enumerate(ranked[:8]):
        corro = len(srcs)
        pins = 1 if i == 0 else 0
        state, retention = state_for(corro, pins)
        ent_items.append({
            "id": uid(persona, "ent", ent),
            "scopeId": f"sc-{persona}-scope",
            "observationType": "entity",
            "content": ent,
            "state": state,
            "retentionScore": round(retention, 2),
            "pinCount": pins,
            "retrievalCount": max(0, 8 - i),
            "corroborationCount": corro,
            "createdAt": NOW_S - 86400 * (i + 1),
            "lastAccessedAt": NOW_S - 3600 * (i + 1),
            "sourceId": source_id(persona, sorted(srcs)[0]),
        })

    # ---- Concepts: the concept graph builds a node per salient entity
    # (ConceptNode::new_candidate), linked to every source it co-occurs in. A
    # concept seen in 3+ sources is promoted to canonical; otherwise candidate.
    concepts: list[dict] = []
    for ent, srcs in ranked[:6]:
        defn = entity_first_sentence.get(ent, "")
        if len(defn) > 130:
            defn = defn[:127].rstrip() + "…"
        state = "canonical" if len(srcs) >= 3 else "candidate"
        concepts.append({
            "id": uid(persona, "concept", ent),
            "label": ent,
            "definition": defn,
            "state": state,
            "relatedSourceIds": [source_id(persona, s) for s in sorted(srcs)],
        })

    return {"entities": ent_items, "facts": facts, "concepts": concepts}


def emit(persona: str, plane: dict) -> None:
    body = json.dumps(plane, indent=2, ensure_ascii=False)
    ts = (
        "// AUTO-GENERATED by scripts/showcase/derive_knowledge.py — do not edit by hand.\n"
        "// Deterministic substrate derivation: entities / facts / concepts are\n"
        "// extracted from this persona's GENUINE indexed source files\n"
        "// (docs/showcase/artifacts/" + persona + "/inputs/*.md) using the same\n"
        "// classification rules as the knowledge crate's observation_engine.\n"
        'import type { ShowcaseKnowledgePlane } from "../types";\n\n'
        f"export const {persona}Knowledge: ShowcaseKnowledgePlane = {body};\n"
    )
    (OUT_DIR / f"{persona}.knowledge.ts").write_text(ts, encoding="utf-8")
    print(
        f"{persona:11s} entities={len(plane['entities']):2d} "
        f"facts={len(plane['facts']):2d} concepts={len(plane['concepts']):2d}"
    )


def main() -> None:
    for persona in PERSONAS:
        emit(persona, derive(persona))


if __name__ == "__main__":
    main()
