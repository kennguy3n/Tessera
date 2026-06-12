# The work is the proof: five professionals, five markets, one local-first workspace

*Part 0 of the Tessera showcase series.*

Every AI productivity tool promises the same thing: describe what you want, get a polished
result. The demos all look the same too — a clean prompt box, a confident answer, and a
quiet request that you not look too hard at the space in between.

Tessera is built on the opposite bet. **The space in between is the product.** You bring
the sources. Tessera structures the work into the sections a real deliverable needs. A
language model drafts each section *against your material*. Every claim links back to where
it came from. And none of it leaves your machine.

This series puts that bet on the table with evidence. We followed five professionals across
five markets through a task they actually do, and we captured the whole thing — the messy
inputs they started with, the exact prompts Tessera ran, the generated output, and the live
editor it landed in.

## The five journeys

- **[Maya, a Clinical Privacy Officer](01-healthcare-privacy-officer.md)** has five business
  days to turn a stolen-laptop helpdesk ticket into a defensible HIPAA breach risk
  assessment — using the most sensitive data in the building, which is exactly why it can
  never leave her laptop.
- **[David, a Corporate Paralegal](02-legal-paralegal.md)** abstracts a 40-page SaaS
  agreement into a one-page summary partners trust, plus a tracker so no renewal or notice
  deadline ever lapses.
- **[Priya, a Commercial Credit Officer](03-commercial-credit-officer.md)** assembles a
  credit memo that ties a borrower's financials, collateral, and risks to a clear
  recommendation — and a multi-year projection the credit committee can interrogate.
- **[Sofia, a Nonprofit Development Director](04-nonprofit-development-director.md)** turns
  scattered program notes and outcomes data into a funder-ready grant proposal and a board
  update deck.
- **[Marcus, a Retail Sales-Ops Lead](05-retail-sales-ops-lead.md)** consolidates pipeline,
  performance, and account health into a quarterly business review deck and a clean CRM the
  team can act on.

Between them they cover all four Tessera artifact types — **document, slides, sheet, base** —
and five regulated or detail-heavy markets where "the AI made something up" is not an
acceptable outcome.

Each story is framed around a real **job to be done** — not "play with an AI," but a concrete
deliverable with a deadline, a reviewer, and a consequence for getting it wrong:

| Persona | Job to be done | The deliverable's stakes |
|---------|----------------|--------------------------|
| Maya (healthcare) | File a defensible HIPAA breach risk assessment in 5 days | A regulator and General Counsel will read it |
| David (legal) | Abstract a 40-page SaaS contract so no deadline lapses | Partners sign off; a missed renewal is malpractice-adjacent |
| Priya (finance) | Tie a borrower's financials and risks to a credit recommendation | A credit committee will interrogate every number |
| Sofia (nonprofit) | Turn program data into a funder-ready proposal and board deck | Funding and board confidence ride on it |
| Marcus (retail) | Consolidate pipeline and account health into a QBR | Leadership makes resourcing calls from it |

### Going deeper

Beyond the five journeys, three posts open the hood:

- **[The UI/UX walkthrough](06-ui-ux-walkthrough.md)** — the Create flow, the four editors, and
  the new substrate controls (search tuning, source health, backup/restore, signed export).
- **[The knowledge plane](07-knowledge-plane.md)** — what Tessera extracts, links, and remembers
  on ingest, shown with genuine derived data, and an explicit accounting of the shipping
  surfaces (the Memory page, concept-graph panel, and enriched "Knowledge" citation tab).
- **[An honest competitive assessment](08-competitive-assessment.md)** — where Notion, Coda,
  Claude Projects, NotebookLM, and the local-RAG tools are genuinely better, and where Tessera
  wins, with the gaps stated without spin.

## What makes this different from a normal demo

**1. The artifacts are genuinely generated, not written.**
Every output in this series came out of Tessera's own on-device model — **Ternary-Bonsai 4B**
(the GGUF `Q1_0_g128` build from Tessera's model registry, running on Tessera's PrismML
llama.cpp runtime) — prompted with the *verbatim* section prompts from Tessera's real
template library, grounded only in each persona's source files. We did not edit the model's
prose. Where it hedges, repeats, or leans on a citation, you see exactly that — because that
is what source-backed, on-device generation actually looks like.

**2. You can inspect every step.**
For each persona, the [`artifacts/`](../artifacts) folder contains:
- `inputs/` — the raw source material (helpdesk tickets, contracts, financials, program
  notes, sales exports).
- `prompts/` — a log quoting each template section's prompt verbatim, plus the model's
  output for that section.
- `outputs/` — the final artifact content (Markdown for documents, JSON for
  slides/sheets/bases) and a human-readable preview.

**3. The screenshots are the real app.**
Not mockups. The document outline panel, the spreadsheet grid, the database field types and
dropdowns, the slide deck navigator — all captured from the live Tessera renderer with the
generated content loaded in.

**4. Citations are first-class.**
Throughout the outputs you'll see markers like `[02-endpoint-mdm-report.md]`. Those are the
model pointing at the source file a claim came from. In a compliance report or a credit
memo, "where did this number come from?" is not a nice-to-have — it's the whole job.

## The principle underneath all five stories

Tessera is **local-first**. Your data lives on your machine; nothing is sent anywhere
without an explicit, visible action. The index is local. The model runs locally. The
sources are folders and files you point it at. For Maya's PHI, David's privileged contracts,
and Priya's borrower financials, that isn't a feature — it's the precondition for using an
AI tool at all.

The rest of this series is the evidence. Each post walks one persona from input to artifact,
shows the prompt that did the work, and links to the raw files so you can check it yourself.

Start with [Maya's HIPAA breach assessment →](01-healthcare-privacy-officer.md)
