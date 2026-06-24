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

The interface has been polished around the **KChat** design language — a soft lavender surface,
warm near-black text, deep purple accents, rounded cards, and a clear progressive-disclosure flow
so that non-technical SMEs and mass users feel confident from the first screen. Every screenshot
in this showcase is a real capture of the live renderer in that theme.

Behind those artifacts is the current editor surface: each of the four editors (document,
slides, sheet, base) opens an in-editor **template gallery** and can save the current artifact
as a reusable, portable template; bases add an **App mode** that turns a table into a
lightweight internal app (app-shell nav, record detail, runtime data-entry forms, dashboard);
slides carry **Brand Kits** with brand-faithful PPTX / PDF / HTML export; and every AI action
runs through a deliberate multi-step **Skills engine** with per-step checks so a small
on-device model produces structured output. The template library spans 287 English templates
across all six artifact types (530 including the nine localized locales), ten industries, and
country / jurisdiction variants.

## How the artifacts were generated

- **Model:** **Ternary-Bonsai 4B** — Tessera's own design text model, the GGUF `Q1_0_g128`
  build registered in [`sidecars/models.json`](../../sidecars/models.json) (`ternary-bonsai-4b-gguf`),
  running on Tessera's PrismML llama.cpp runtime on a CPU-only machine. No external API, no
  cloud inference, no hand-editing of the model's prose. The generator
  ([`scripts/showcase/generate.py`](../../scripts/showcase/generate.py)) hard-fails on any
  model id that is not a design text model in the registry, so an off-design stand-in model
  can never silently produce these artifacts.
- **Prompts:** the _verbatim_ section prompts from Tessera's real template library
  (`templates/documents/*.yaml`, `templates/slides/*.yaml`, etc.). The prompt logs in each
  persona's `prompts/` folder quote them directly.
- **Grounding:** each section was generated against that persona's source files only. The
  inline `[NN-source-file.md]` markers you see in the outputs are the model citing the
  material it drew from.
- **Rendering:** the screenshots are the genuine Tessera editor (run via a dev-only,
  query-param-gated showcase bridge that loads the pre-generated artifacts into the live
  renderer). The document/sheet/base/slide chrome, outline panels, field types, and
  citations are all the real app.

> The Ternary-Bonsai family is Tessera's bundled, on-device model line (1.7B / 4B / 8B),
> selected automatically by device tier. Its 1.58-bit ternary quantization (`Q1_0_g128`)
> requires Tessera's packaged PrismML llama.cpp fork — stock llama.cpp/Ollama cannot load
> it. This showcase reproduces the shipping path exactly: the same model, the same `Q1_0_g128`
> quant, and the same runtime a real Tessera install uses.

---

## The five personas

| #   | Persona                                     | Market                              | Artifacts                                                          |
| --- | ------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| 1   | **Maya Okonkwo** — Clinical Privacy Officer | Healthcare (regional health system) | HIPAA incident report (document) + privacy incident tracker (base) |
| 2   | **David Reyes** — Corporate Paralegal       | Legal (mid-size corporate firm)     | Contract summary (document) + obligation & renewal tracker (sheet) |
| 3   | **Priya Nair** — Commercial Credit Officer  | Finance (regional commercial bank)  | Credit memo (document) + 3-year projection (sheet)                 |
| 4   | **Sofia Alvarez** — Development Director    | Nonprofit (community services)      | Grant proposal (document) + board update (slides)                  |
| 5   | **Marcus Chen** — Sales Operations Lead     | Retail / consumer goods             | QBR deck (slides) + CRM (base)                                     |

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
│   ├── 06-ui-ux-walkthrough.md    the Create flow, editors, substrate controls, provenance
│   ├── 07-knowledge-plane.md      what the substrate extracts/links/remembers + shipping browse UI
│   └── 08-competitive-assessment.md  honest comparison vs Notion/Coda/Claude/local RAG
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
