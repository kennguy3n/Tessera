# Tessera Product Showcase

A business-ready demonstration of Tessera anchored to five real-world personas. Each
journey starts from messy source material a professional actually has on their laptop,
runs it through Tessera's real template prompts and a **local** language model, and ends
in an editable, source-cited artifact — a document, a presentation, a spreadsheet, or a
database.

Everything here is inspectable end to end: the **inputs** the persona started with, the
**exact template section prompts** Tessera sent to the model, and the **generated output**
that landed in the editor. Nothing is hand-written marketing copy dressed up as a product
result.

---

## Why this showcase exists

Most "AI workspace" demos show a clean prompt box and a polished result, and ask you to
trust the gap in between. Tessera's pitch is the opposite: **the gap is the product.** You
bring the sources, Tessera structures the work, the model drafts each section against your
material, and every claim links back to where it came from — all without your data leaving
the machine.

This showcase proves that claim with five personas across five markets, all four artifact
types, and full input → prompt → output transparency.

## How the artifacts were generated

- **Model:** `llama3.2:3b`, running locally via Ollama on a CPU-only machine. No external
  API, no cloud inference, no hand-editing of the model's prose.
- **Prompts:** the *verbatim* section prompts from Tessera's real template library
  (`templates/documents/*.yaml`, `templates/slides/*.yaml`, etc.). The prompt logs in each
  persona's `prompts/` folder quote them directly.
- **Grounding:** each section was generated against that persona's source files only. The
  inline `[NN-source-file.md]` markers you see in the outputs are the model citing the
  material it drew from.
- **Rendering:** the screenshots are the genuine Tessera editor (run via a dev-only,
  query-param-gated showcase bridge that loads the pre-generated artifacts into the live
  renderer). The document/sheet/base/slide chrome, outline panels, field types, and
  citations are all the real app.

> Tessera ships a bundled 1.7B model for true zero-setup use. This showcase used
> `llama3.2:3b` because the bundled model's ternary quantization needs Tessera's
> packaged inference fork, which isn't reproducible in a generic CI sandbox. The pipeline,
> prompts, and grounding are otherwise identical to the shipping product.

---

## The five personas

| # | Persona | Market | Artifacts |
|---|---------|--------|-----------|
| 1 | **Maya Okonkwo** — Clinical Privacy Officer | Healthcare (regional health system) | HIPAA incident report (document) + privacy incident tracker (base) |
| 2 | **David Reyes** — Corporate Paralegal | Legal (mid-size corporate firm) | Contract summary (document) + obligation & renewal tracker (sheet) |
| 3 | **Priya Nair** — Commercial Credit Officer | Finance (regional commercial bank) | Credit memo (document) + 3-year projection (sheet) |
| 4 | **Sofia Alvarez** — Development Director | Nonprofit (community services) | Grant proposal (document) + board update (slides) |
| 5 | **Marcus Chen** — Sales Operations Lead | Retail / consumer goods | QBR deck (slides) + CRM (base) |

Across the five, every artifact type is represented: **document, slides, sheet, base.**

## How to read this folder

```
docs/showcase/
├── README.md                  ← you are here
├── blog/                      ← the narrative series
│   ├── 00-introduction.md         the thesis + how to read the proof
│   ├── 01-healthcare-privacy-officer.md
│   ├── 02-legal-paralegal.md
│   ├── 03-commercial-credit-officer.md
│   ├── 04-nonprofit-development-director.md
│   ├── 05-retail-sales-ops-lead.md
│   └── 06-ui-ux-walkthrough.md    the Create flow, editors, and provenance
├── stakeholder/               ← production-readiness docs for buyers/teams
│   ├── executive-one-pager.md
│   ├── security-and-privacy-brief.md
│   ├── competitive-positioning.md
│   ├── buyers-guide-and-roi.md
│   └── getting-started.md
├── artifacts/<persona>/       ← the raw proof
│   ├── inputs/                    source material the persona started with
│   ├── prompts/                   verbatim template prompts + model output log
│   └── outputs/                   generated artifact content (md / json) + previews
└── assets/screenshots/        ← in-app captures of the real editor
```

Start with [`blog/00-introduction.md`](blog/00-introduction.md). Each persona post links
to its inputs, prompts, outputs, and screenshot so you can verify every claim.
