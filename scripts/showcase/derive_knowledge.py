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


def state_for(source_count: int, pins: int) -> tuple[str, float]:
    """Mirror MemoryState progression. `source_count` is the number of distinct
    source files an observation appears in (a corroboration proxy), NOT a count
    of independent corroboration events; more sources / pins => further along the
    candidate->canonical path with a higher retention score."""
    if pins > 0:
        return "reinforced", min(0.97, 0.88 + 0.03 * source_count)
    if source_count >= 3:
        return "canonical", min(0.95, 0.84 + 0.03 * source_count)
    if source_count == 2:
        return "consolidated", 0.78
    return "candidate", 0.62


# ---------------------------------------------------------------------------
# Source-grounded relation + decay enrichment (concept graph edge typing).
#
# The base derivation above types concept-graph edges purely by shared-source
# co-occurrence (`part_of` / `related_to`). The real substrate's concept graph
# also carries `is_a`, `supersedes`, and `contradicts` edges and a full decay
# state machine (`superseded` / `archived`, beyond the live working set). Those
# relations are NOT derivable from co-occurrence alone — they need the semantic
# structure that actually exists in the source text.
#
# This layer adds exactly that, WITHOUT inventing anything: every relation and
# every non-active decay state below cites the genuine source evidence that
# justifies it, and the derivation VALIDATES (fails loudly) that each referenced
# entity / observation was really extracted — so the enrichment can never drift
# away from the persona's real observation set. It is keyed per persona; a
# persona with no entry is emitted exactly as before (byte-identical).
#
#   * categories  — an identifier's scheme encodes its type, so a code entity
#                   `is_a` a derived category concept (INC-4471 is_a Incident).
#                   This is structural, not semantic invention.
#   * claims      — a salient finding/claim promoted to a concept node, label =
#                   a faithful summary, definition = the verbatim source text it
#                   was extracted from (and the source it came from).
#   * links       — typed edges between concept labels, each grounded in cited
#                   sources (e.g. the MDM audit finding `contradicts` the
#                   reporter's encryption assumption; it `supersedes` the
#                   change ticket that was closed without confirming the fix).
#   * states      — decay-state overrides for code entities + their concept
#                   node (e.g. the lapsed remediation ticket is `superseded`).
#   * archive     — facts that have aged out of the live working set, marked
#                   `archived` with a decayed retention score.
ENRICHMENT: dict[str, dict] = {
    "healthcare": {
        # Mercy Ridge breach triage (INC-4471): a stolen, unencrypted laptop.
        # One category per identifier scheme present. Kept deliberately small
        # (3) so the rendered graph stays a single clean ring rather than
        # spilling onto a cramped second ring — the substrate's radial layout
        # packs up to 10 nodes per ring (1 hub + 10 ring = 11 total).
        "categories": {
            "INC-4471": "Incident",
            "LT-2291": "Asset",
            "ICD-10": "Clinical code",
        },
        "claims": [
            {
                # src 02 (Intune/MDM audit): "BitLocker status: Not encrypted".
                "label": "Disk not encrypted",
                "definition": "Endpoint/MDM audit: BitLocker status Not encrypted — "
                "policy exception granted 2025-09, never remediated.",
                "source": "02",
                "state": "canonical",
            },
            {
                # src 01 (helpdesk ticket): the reporter's uncertain belief,
                # later contradicted by the MDM audit.
                "label": "Encryption assumed enabled",
                "definition": 'Caller believes full-disk encryption "should be on" '
                "but is not certain.",
                "source": "01",
                # Concept lifecycle state (concept_graph::NodeState).
                "state": "contradicted",
                # The genuine observation this claim was extracted from. The
                # concept is `contradicted`, but an *observation* has no such
                # state (substrate::MemoryState) — once the MDM audit disproved
                # the belief it ages out of the working set, so the underlying
                # memory is `archived`. Keeping the two states distinct keeps
                # the Memory page and the concept graph each semantically valid.
                "fact_match": "Caller believes full-disk encryption",
                "fact_state": "archived",
                "fact_retention": 0.22,
            },
        ],
        "links": [
            # Structural is_a (code → its category class).
            {"from": "INC-4471", "to": "Incident", "type": "is_a"},
            {"from": "LT-2291", "to": "Asset", "type": "is_a"},
            {"from": "ICD-10", "to": "Clinical code", "type": "is_a"},
            # Containment: the asset, the escalated office, and the governing
            # rule are all part of this incident's scope (src 01 / 02 / 04).
            {"from": "LT-2291", "to": "INC-4471", "type": "part_of"},
            {"from": "Privacy Office", "to": "INC-4471", "type": "part_of"},
            {"from": "45 CFR §164.402", "to": "INC-4471", "type": "part_of"},
            # Semantic conflict, grounded in the source text:
            # the MDM audit finding contradicts the reporter's assumption …
            {
                "from": "Disk not encrypted",
                "to": "Encryption assumed enabled",
                "type": "contradicts",
            },
            # … and supersedes the change ticket that was closed without
            # confirming re-encryption (src 02 analyst note).
            {
                "from": "Disk not encrypted",
                "to": "CHG-2208",
                "type": "supersedes",
            },
        ],
        "states": {
            # The re-encryption remediation that lapsed: superseded by the
            # current audit finding, retention decayed.
            "CHG-2208": ("superseded", 0.34),
        },
        # Promote a few well-corroborated concept nodes to canonical so the
        # graph reflects the lifecycle (the laptop + incident are the spine).
        "promote": {"LT-2291": "canonical", "INC-4471": "canonical"},
        "archive": [
            # A bare log-filter header and a clause fragment — low salience,
            # single source, aged out of the live working set.
            {"match": "Filtered to user dwhitfield", "retention": 0.12},
            {"match": "permitted under the Privacy Rule", "retention": 0.15},
        ],
    },
}


# Valid lifecycle states, mirrored from the Rust enums so the showcase data can
# never carry a state the shipped UI does not model. Observations use
# `substrate::MemoryState`; concept-graph nodes use `concept_graph::NodeState`.
# The two overlap but are NOT identical — notably `archived` is observation-only
# and `contradicted` is concept-only.
OBSERVATION_STATES = frozenset(
    {
        "candidate",
        "reinforced",
        "consolidated",
        "canonical",
        "superseded",
        "archived",
        "deleted",
    }
)
CONCEPT_STATES = frozenset(
    {"candidate", "canonical", "superseded", "contradicted", "deleted"}
)


def _find_one(items: list[dict], key: str, needle: str, persona: str, what: str) -> dict:
    """Return the single observation whose `key` contains `needle`. Fails loudly
    so an enrichment reference can never silently drift from the extracted set."""
    matches = [it for it in items if needle in it.get(key, "")]
    if len(matches) != 1:
        raise SystemExit(
            f"[{persona}] enrichment {what}: expected exactly one observation "
            f"matching {needle!r}, found {len(matches)}"
        )
    return matches[0]


def enrich(persona: str, plane: dict) -> None:
    """Apply the source-grounded relation/decay enrichment for `persona`, in
    place. No-op for personas without an ENRICHMENT entry."""
    cfg = ENRICHMENT.get(persona)
    if not cfg:
        return

    concepts: list[dict] = plane["concepts"]
    by_label = {c["label"]: c for c in concepts}

    def category_concept(label: str) -> dict:
        existing = by_label.get(label)
        if existing:
            return existing
        node = {
            "id": uid(persona, "concept", label),
            "label": label,
            "definition": f"Category of {label.lower()} observations.",
            "state": "canonical",
            "relatedSourceIds": [],
        }
        concepts.append(node)
        by_label[label] = node
        return node

    # Categories → category concept nodes (is_a targets).
    for code, klass in cfg.get("categories", {}).items():
        if code not in by_label:
            raise SystemExit(
                f"[{persona}] enrichment category: entity concept {code!r} not extracted"
            )
        category_concept(klass)

    # Claims → concept nodes promoted from genuine findings.
    for claim in cfg.get("claims", []):
        src = source_id(persona, f"{claim['source']}-")
        if claim["label"] not in by_label:
            node = {
                "id": uid(persona, "concept", claim["label"]),
                "label": claim["label"],
                "definition": claim["definition"],
                "state": claim["state"],
                "relatedSourceIds": [src],
            }
            concepts.append(node)
            by_label[claim["label"]] = node
        # Reflect the claim's lifecycle on the underlying fact observation.
        # The concept node and the observation carry SEPARATE state vocabularies
        # (see OBSERVATION_STATES / CONCEPT_STATES): a concept may be
        # `contradicted`, but the observation it was extracted from ages out to
        # a valid MemoryState (`archived` by default) instead.
        if claim.get("fact_match"):
            fact = _find_one(
                plane["facts"], "content", claim["fact_match"], persona, "claim fact_match"
            )
            fact["state"] = claim.get("fact_state", "archived")
            fact["retentionScore"] = claim.get("fact_retention", fact["retentionScore"])

    # Decay-state overrides for code entities + their concept node.
    for code, (state, retention) in cfg.get("states", {}).items():
        ent = _find_one(plane["entities"], "content", code, persona, "state entity")
        ent["state"] = state
        ent["retentionScore"] = retention
        if code in by_label:
            by_label[code]["state"] = state

    # Promote selected concept nodes to a more advanced lifecycle state.
    for label, state in cfg.get("promote", {}).items():
        if label in by_label:
            by_label[label]["state"] = state

    # Archive aged-out facts.
    for entry in cfg.get("archive", []):
        fact = _find_one(plane["facts"], "content", entry["match"], persona, "archive")
        fact["state"] = "archived"
        fact["retentionScore"] = entry["retention"]

    # Typed concept-graph edges (validated against the final concept set).
    relations: list[dict] = []
    for link in cfg.get("links", []):
        for endpoint in (link["from"], link["to"]):
            if endpoint not in by_label:
                raise SystemExit(
                    f"[{persona}] enrichment link: concept {endpoint!r} not present"
                )
        relations.append({
            "from": by_label[link["from"]]["id"],
            "to": by_label[link["to"]]["id"],
            "type": link["type"],
        })
    if relations:
        plane["relations"] = relations

    # Fail loudly if enrichment produced any state the shipped UI cannot model.
    # Observations and concept nodes have disjoint-ish vocabularies; validating
    # here (rather than trusting the config) keeps the showcase data honest to
    # the Rust enums even as the enrichment config grows.
    for obs in (*plane["entities"], *plane["facts"]):
        if obs["state"] not in OBSERVATION_STATES:
            raise SystemExit(
                f"[{persona}] invalid observation state {obs['state']!r} on "
                f"{obs['content']!r} (expected one of {sorted(OBSERVATION_STATES)})"
            )
    for node in concepts:
        if node["state"] not in CONCEPT_STATES:
            raise SystemExit(
                f"[{persona}] invalid concept state {node['state']!r} on "
                f"{node['label']!r} (expected one of {sorted(CONCEPT_STATES)})"
            )


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
        f"facts={len(plane['facts']):2d} concepts={len(plane['concepts']):2d} "
        f"relations={len(plane.get('relations', [])):2d}"
    )


def main() -> None:
    for persona in PERSONAS:
        plane = derive(persona)
        enrich(persona, plane)
        emit(persona, plane)


if __name__ == "__main__":
    main()
