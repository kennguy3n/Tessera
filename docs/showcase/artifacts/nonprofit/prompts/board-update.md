# Prompt log — Board Update — Program Impact & Development

- **Persona:** Sofia Alvarez, Development Director, Riverside Youth Coalition
- **Template:** `templates/slides/board-update.yaml` (Board of Directors Update)
- **Model:** llama3.2:3b (local, via Ollama)
- **Input source files:** 01-program-notes-and-outcomes.md, 02-funder-rfp-and-board-context.md

Tessera runs each template section prompt below against the source files, grounded locally. The generated output is in the matching `outputs/` file.

### Slide 1: Title and Quarter

**Template section prompt (verbatim from `templates/slides/board-update.yaml`):**

> Title slide with company name, fiscal quarter, fiscal year, board meeting date, and the presenter. List the attendees and any non-board invitees.

### Slide 2: Executive Summary

**Template section prompt (verbatim from `templates/slides/board-update.yaml`):**

> One-slide TL;DR: the headline (we beat / we missed / we pivoted), the three things the board needs to know, the asks of the board, and the overall risk posture (green / yellow / red).

### Slide 3: Quarterly Performance

**Template section prompt (verbatim from `templates/slides/board-update.yaml`):**

> KPI dashboard: revenue, growth rate, gross margin, EBITDA / cash burn, runway, key product metrics (DAU / NPS / retention), pipeline coverage. Each metric: actual vs. plan, year-over-year delta, and a one-line explanation of the variance.

### Slide 4: Financial Detail

**Template section prompt (verbatim from `templates/slides/board-update.yaml`):**

> P&L, balance sheet, and cash-flow highlights. Cash position, burn rate, runway in months, planned use of remaining cash, and any anticipated need for capital. Quote the underlying audited or reviewed source.

### Slide 5: Strategic Progress

**Template section prompt (verbatim from `templates/slides/board-update.yaml`):**

> Status of the annual / multi-year strategic priorities. For each priority: this quarter's milestone, what was delivered, what slipped, and the recovery plan for any slippage.

### Slide 6: Product and Customer

**Template section prompt (verbatim from `templates/slides/board-update.yaml`):**

> Product launches this quarter, key customer wins and losses, churn analysis, NPS / CSAT trend, and the product roadmap for the next two quarters at strategic grain (not feature lists).

### Slide 7: Talent and Organization

**Template section prompt (verbatim from `templates/slides/board-update.yaml`):**

> Org health: hiring plan progress, key leadership hires, regrettable attrition, succession planning, and any D&I / culture metrics the board has chosen to track. Flag executive gaps or risks.

### Slide 8: Risks and Mitigations

**Template section prompt (verbatim from `templates/slides/board-update.yaml`):**

> Top five enterprise risks: description, likelihood, impact, mitigation in flight, and the residual risk. Distinguish board-level risks (existential, strategic) from operational risks the team is handling.

### Slide 9: Asks and Decisions Required

**Template section prompt (verbatim from `templates/slides/board-update.yaml`):**

> Explicit list of asks and decisions for the board: approve the budget revision, ratify an offer letter, authorize a financing, approve a strategic partnership, accept a related-party transaction. Each ask with the recommended action.

### Slide 10: Appendix

**Template section prompt (verbatim from `templates/slides/board-update.yaml`):**

> Reference materials available in appendix: full financials, hiring scorecard, customer logo wall, committee reports (audit, compensation, nominating), and any management-letter responses.
