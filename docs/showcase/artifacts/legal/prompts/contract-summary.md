# Prompt log — Contract Summary — Master SaaS Agreement (Northwind × Acme)

- **Persona:** David Reyes, Corporate Paralegal, Hartwell & Cho LLP
- **Template:** `templates/documents/contract-summary.yaml` (Contract Summary)
- **Model:** Ternary-Bonsai 4B (GGUF Q1_0_g128) — `ternary-bonsai-4b-gguf`, via the PrismML llama.cpp `llama-server` (Tessera's on-device runtime)
- **Input source files:** 01-master-saas-agreement.md, 02-reviewer-notes-and-redlines.md

Tessera runs each template section prompt below against the source files, grounded locally. The generated output is in the matching `outputs/` file.

### Section 1: Contract Identification

**Template section prompt (verbatim from `templates/documents/contract-summary.yaml`):**

> State the contract title, the executing parties (legal entity names, jurisdictions of formation), effective date, expiration or renewal terms, governing law, and venue / dispute resolution forum.


### Section 2: Business Purpose and Scope

**Template section prompt (verbatim from `templates/documents/contract-summary.yaml`):**

> Summarize the commercial purpose of the contract, the scope of services or goods, key deliverables, milestones, and acceptance criteria. Note any exclusivity, non-compete, or restrictive covenants.


### Section 3: Financial Terms

**Template section prompt (verbatim from `templates/documents/contract-summary.yaml`):**

> Tabulate fees, pricing structure (fixed, time-and-materials, subscription, royalty), payment terms (net 30/60/90), late payment interest, currency, taxes, expense reimbursement, audit rights, and any most-favored-nation or price-adjustment clauses.

**Output format:** `table`


### Section 4: Key Obligations and Performance Standards

**Template section prompt (verbatim from `templates/documents/contract-summary.yaml`):**

> Identify each party's material obligations: deliverables, SLAs / uptime commitments, reporting cadence, regulatory compliance, and any conditions precedent or subsequent. Use a bulleted list organized by party.

**Output format:** `bullets`


### Section 5: Representations, Warranties, and Disclaimers

**Template section prompt (verbatim from `templates/documents/contract-summary.yaml`):**

> Summarize the representations and warranties (authority, no conflict, IP ownership, non-infringement, compliance with law), survival periods, and any express disclaimers (e.g., "AS IS", no implied warranty of merchantability).


### Section 6: Indemnification and Limitation of Liability

**Template section prompt (verbatim from `templates/documents/contract-summary.yaml`):**

> Describe the indemnification structure (mutual vs. one-way, triggers, defense control, settlement consent), and the limitation of liability (cap amount, exclusions for IP / data / gross negligence, consequential damages waiver). Flag any uncapped exposure.


### Section 7: IP and Data Rights

**Template section prompt (verbatim from `templates/documents/contract-summary.yaml`):**

> Cover ownership of background IP, foreground IP / work product, licenses granted (scope, term, exclusivity, sublicensable), moral rights waivers, and data ownership / processing rights (controller vs. processor, DPA references, cross-border transfer mechanism).


### Section 8: Term, Termination, and Transition

**Template section prompt (verbatim from `templates/documents/contract-summary.yaml`):**

> State the initial term, renewal mechanics (auto-renew vs. affirmative), and the termination rights (for cause, for convenience, with notice period). Describe the post-termination transition obligations: data return / deletion, knowledge transfer, ongoing licenses, and survival of provisions.


### Section 9: Risk Heatmap

**Template section prompt (verbatim from `templates/documents/contract-summary.yaml`):**

> Risk-rank each material clause on a Low / Medium / High scale. For each High risk, propose a specific redline or fallback position to negotiate. For each Medium, note the acceptable cap or carve-out.

**Output format:** `table`


### Section 10: Recommendations

**Template section prompt (verbatim from `templates/documents/contract-summary.yaml`):**

> Concrete recommendation: sign as drafted, sign with redlines below, escalate to senior counsel, or decline. Justify the recommendation in two-to-three sentences referencing the highest-risk clauses.

