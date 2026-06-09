# Prompt log — Credit Memo — Riverbend Logistics Equipment Facility

- **Persona:** Priya Nair, Commercial Credit Officer, Cascade Regional Bank
- **Template:** `templates/documents/loan-proposal.yaml` (Loan / Credit Proposal)
- **Model:** Ternary-Bonsai 4B (GGUF Q1_0_g128) — `ternary-bonsai-4b-gguf`, via the PrismML llama.cpp `llama-server` (Tessera's on-device runtime)
- **Input source files:** 01-borrower-financials.md, 02-market-and-risk-notes.md

Tessera runs each template section prompt below against the source files, grounded locally. The generated output is in the matching `outputs/` file.

### Section 1: Transaction Summary

**Template section prompt (verbatim from `templates/documents/loan-proposal.yaml`):**

> Borrower name, facility type (term loan, revolver, ABL, mortgage, mezzanine), requested amount, proposed term and amortization, all-in pricing (rate, fees), use of proceeds, and the recommended action (approve / approve with modifications / decline). Identify the credit officer and the approval level required.


### Section 2: Borrower Profile

**Template section prompt (verbatim from `templates/documents/loan-proposal.yaml`):**

> Borrower's legal structure, jurisdiction, ownership, principal officers, industry, geography, years in business, headcount, and a brief history (origination, key milestones, recent ownership changes).


### Section 3: Business Description and Strategy

**Template section prompt (verbatim from `templates/documents/loan-proposal.yaml`):**

> Product and service offerings, customer base (concentration, tenure, contract terms), suppliers, competitive position, management depth, and the borrower's strategic plan for the next 24-36 months that the facility supports.


### Section 4: Financial Performance

**Template section prompt (verbatim from `templates/documents/loan-proposal.yaml`):**

> Three-year financial summary: revenue, EBITDA, net income, free cash flow, total debt, equity, and key credit ratios (debt/EBITDA, fixed-charge coverage, interest coverage, debt/equity). Note the basis (audited, reviewed, compiled, tax-basis, internal) and any non-recurring adjustments.

**Output format:** `table`


### Section 5: Cash Flow and Repayment Source

**Template section prompt (verbatim from `templates/documents/loan-proposal.yaml`):**

> Demonstrate the primary repayment source from operating cash flow under base / downside scenarios. Identify the secondary repayment source (asset sale, refinance, guarantor) and tertiary if applicable. Test against a stressed downside (e.g., 20% revenue decline, 200 bps higher rates).


### Section 6: Collateral and Security Package

**Template section prompt (verbatim from `templates/documents/loan-proposal.yaml`):**

> Describe the collateral: real estate (appraised value, LTV), equipment (NOLV), inventory and accounts receivable (advance rates, eligibility criteria), cash, securities, IP, or blanket lien. Identify the lien position, prior liens, and any subordination or intercreditor agreements.

**Output format:** `table`


### Section 7: Guarantors and Other Credit Support

**Template section prompt (verbatim from `templates/documents/loan-proposal.yaml`):**

> List personal and corporate guarantors with their financial strength, the form of guaranty (limited vs. unlimited, validity vs. payment), and any other credit support (letters of credit, deposit accounts, parent comfort letter).


### Section 8: Covenants and Reporting Requirements

**Template section prompt (verbatim from `templates/documents/loan-proposal.yaml`):**

> Proposed financial covenants (debt/EBITDA cap, fixed-charge coverage floor, minimum liquidity, capex limit) with cushion to projected performance, affirmative covenants (financial reporting cadence, insurance, compliance certificates), negative covenants (additional debt, liens, dividends, M&A), and reporting requirements (frequency, format, certifying officer).

**Output format:** `table`


### Section 9: Risk Assessment and Risk Rating

**Template section prompt (verbatim from `templates/documents/loan-proposal.yaml`):**

> State the proposed risk rating per the bank's internal scale, the rationale, and how it compares to the prior period. Identify the principal risks (industry, customer concentration, management succession, regulatory) and the mitigants.


### Section 10: Approval Recommendation

**Template section prompt (verbatim from `templates/documents/loan-proposal.yaml`):**

> Final recommendation with conditions (any pre-funding items, post-close milestones, covenant step-downs at year 2), approval authority required, and the signatures needed. Include the relationship view: total commitment, anticipated revenue from cross-sell, and the relationship profitability analysis.

