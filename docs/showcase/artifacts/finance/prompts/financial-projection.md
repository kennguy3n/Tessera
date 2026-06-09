# Prompt log — Riverbend Logistics — 3-Year Projection

- **Persona:** Priya Nair, Commercial Credit Officer, Cascade Regional Bank
- **Template:** `templates/sheets/sales-forecast.yaml` (Sales Forecast)
- **Model:** Ternary-Bonsai 4B (GGUF Q1_0_g128) — `ternary-bonsai-4b-gguf`, via the PrismML llama.cpp `llama-server` (Tessera's on-device runtime)
- **Input source files:** 01-borrower-financials.md, 02-market-and-risk-notes.md

Tessera runs each template section prompt below against the source files, grounded locally. The generated output is in the matching `outputs/` file.

### Spreadsheet generation

**Template:** `templates/sheets/sales-forecast.yaml` — Sales Forecast

**Template sections:** ['Forecast Identification', 'Historical Baseline', 'Seasonality and Trend Decomposition', 'Driver Assumptions', 'Base / Upside / Downside Scenarios', 'Channel and Segment Detail', 'Capacity and Constraint Checks', 'Actuals vs. Forecast Tracking', 'Risks to Plan']

**Instruction:** Sales forecast workbook with historical trend, seasonality, scenario sensitivity, and actuals tracking

**Structure hint:** Columns: Line Item ($000s unless %), FY2026E, FY2027E, FY2028E. Rows: Revenue, Gross Margin %, EBITDA, New Facility Debt Service, Total Debt Service, DSCR (x), Net Income, Cash. Project forward from the historicals (FY2023-FY2025: revenue 24,100 / 27,850 / 31,600; EBITDA 3,050 / 3,720 / 4,310) using realistic mid-single-digit growth and the new $3.2M facility. Keep numbers internally consistent.

