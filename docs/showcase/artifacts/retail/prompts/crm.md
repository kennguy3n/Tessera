# Prompt log — Sales Pipeline — Key Accounts

- **Persona:** Marcus Chen, Sales Operations Lead, Northwind Outdoor Co.
- **Template:** `templates/bases/crm.yaml` (CRM (Contacts, Companies, Deals))
- **Model:** Ternary-Bonsai 4B (GGUF Q1_0_g128) — `ternary-bonsai-4b-gguf`, via the PrismML llama.cpp `llama-server` (Tessera's on-device runtime)
- **Input source files:** 01-quarterly-sales-data.md, 02-key-accounts-and-deals.md

Tessera runs each template section prompt below against the source files, grounded locally. The generated output is in the matching `outputs/` file.

### Base generation

**Template:** `templates/bases/crm.yaml` — CRM (Contacts, Companies, Deals)

**Purpose:** Lightweight CRM base with contacts, companies, deals, activities, and pipeline stages

**Template sections:** ['Companies', 'Contacts', 'Deals and Pipeline Stages', 'Activities and Notes', 'Forecast Roll-Up', 'Lead Routing and SLA', 'Hygiene and Governance']

**Structure hint:** Use these fields: Account (text), Region (select: West / Central / East / Intl), Owner (text), ARR ($) (text), Open Opportunity (text), Amount ($) (text), Stage (select: Pipeline / Best Case / Commit), Health (select: Green / Yellow / Red). One record per strategic account / open opportunity from the source notes (Summit Sports, Alpine Co-op, TrailMart, Nordic Outfitters, Urban Trek, RidgeLine).

