# Prompt log — Contract Obligation & Renewal Tracker

- **Persona:** David Reyes, Corporate Paralegal, Hartwell & Cho LLP
- **Template:** `templates/sheets/tracker.yaml` (Tracker)
- **Model:** llama3.2:3b (local, via Ollama)
- **Input source files:** 01-master-saas-agreement.md, 02-reviewer-notes-and-redlines.md

Tessera runs each template section prompt below against the source files, grounded locally. The generated output is in the matching `outputs/` file.

### Spreadsheet generation

**Template:** `templates/sheets/tracker.yaml` — Tracker

**Template sections:** ['Tracker Header', 'Items', 'Status Summary', 'Blockers and Risks', 'Recent Updates']

**Instruction:** General-purpose tracker for items with status, owner, due date, priority, notes, and last-updated columns

**Structure hint:** Columns: Obligation, Responsible Party, Trigger / Clause, Due Date, Priority, Status. Each row is a concrete obligation or deadline drawn from the agreement and reviewer notes (e.g. non-renewal notice deadline 2027-12-31, breach notification 72h, SLA credit triggers, liability-cap negotiation, fee true-up). Use ISO dates.

