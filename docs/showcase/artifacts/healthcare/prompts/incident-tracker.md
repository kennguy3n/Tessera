# Prompt log — Privacy Incident Tracker

- **Persona:** Maya Okonkwo, Clinical Privacy Officer, Mercy Ridge Health
- **Template:** `templates/bases/incident-tracker.yaml` (Incident Tracker)
- **Model:** llama3.2:3b (local, via Ollama)
- **Input source files:** 01-helpdesk-ticket-INC-4471.md, 02-endpoint-mdm-report.md, 03-ehr-export-log.md, 04-policy-and-context.md

Tessera runs each template section prompt below against the source files, grounded locally. The generated output is in the matching `outputs/` file.

### Base generation

**Template:** `templates/bases/incident-tracker.yaml` — Incident Tracker

**Purpose:** Incident / outage tracker with severity, status, timeline, root cause, and post-mortem linkage

**Template sections:** ['Incident Records', 'Impact Assessment', 'Timeline', 'Root Cause and Contributing Factors', 'Corrective Actions', 'Post-Mortem Linkage', 'Trend and Metrics']

**Structure hint:** Use these fields: Incident ID (text), Date Discovered (date), Type (select: Lost Device / Misdirected Email / Unauthorized Access / Business Associate), Severity (select: Low / Medium / High / Critical), Individuals Affected (number), Encrypted (select: Yes / No), Status (select: Open / Risk Assessment / Reportable / Closed-Incident), Owner (text). Create one record for the current INC-4471 lost-laptop event and 6-8 realistic prior privacy incidents for a health system, with varied types and statuses.

