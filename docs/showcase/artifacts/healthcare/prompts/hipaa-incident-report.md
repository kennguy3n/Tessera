# Prompt log — HIPAA Incident Report — Lost Device INC-4471

- **Persona:** Maya Okonkwo, Clinical Privacy Officer, Mercy Ridge Health
- **Template:** `templates/documents/hipaa-incident-report.yaml` (HIPAA Incident Report)
- **Model:** Ternary-Bonsai 4B (GGUF Q1_0_g128) — `ternary-bonsai-4b-gguf`, via the PrismML llama.cpp `llama-server` (Tessera's on-device runtime)
- **Input source files:** 01-helpdesk-ticket-INC-4471.md, 02-endpoint-mdm-report.md, 03-ehr-export-log.md, 04-policy-and-context.md

Tessera runs each template section prompt below against the source files, grounded locally. The generated output is in the matching `outputs/` file.

### Section 1: Incident Summary

**Template section prompt (verbatim from `templates/documents/hipaa-incident-report.yaml`):**

> One-paragraph executive summary of the suspected or confirmed incident. State whether it has been classified as an Incident (still under investigation) or a Breach (45 CFR §164.402 determination complete), the discovery method, the affected systems, and the current containment status.


### Section 2: Discovery and Timeline

**Template section prompt (verbatim from `templates/documents/hipaa-incident-report.yaml`):**

> Construct a numbered timeline of events from initial occurrence through discovery, containment, internal escalation, and (if applicable) external notification. Include date, time (with timezone), the role/individual taking the action, and the source record (ticket, log, witness statement).

**Output format:** `numbered_list`


### Section 3: Affected Individuals and PHI Categories

**Template section prompt (verbatim from `templates/documents/hipaa-incident-report.yaml`):**

> State the count of affected individuals (or the upper-bound estimate during ongoing investigation). Categorize the PHI involved: demographic, medical history, lab/imaging results, prescriptions, billing/insurance, mental health, substance use (42 CFR Part 2), genetic, or other sensitive categories. Note whether the data was encrypted, paper, electronic, or in-transit.


### Section 4: Risk Assessment (45 CFR §164.402)

**Template section prompt (verbatim from `templates/documents/hipaa-incident-report.yaml`):**

> Document the four-factor risk assessment required by the HITECH Act: (1) the nature and extent of the PHI involved, including types of identifiers and likelihood of re-identification; (2) the unauthorized person who used or received the PHI; (3) whether the PHI was actually acquired or viewed; (4) the extent to which risk has been mitigated. Conclude with the breach-vs-incident determination and the rationale.


### Section 5: Root Cause Analysis

**Template section prompt (verbatim from `templates/documents/hipaa-incident-report.yaml`):**

> Identify the root cause(s): technical (misconfiguration, vulnerability), human (training gap, malicious insider, social engineering), process (missing workflow, weak access controls), or third party (business associate failure). Use a 5-Whys or fishbone analysis.


### Section 6: Containment and Remediation Actions

**Template section prompt (verbatim from `templates/documents/hipaa-incident-report.yaml`):**

> List the immediate containment steps already taken (account disable, system isolation, password rotation, backup restore) and the planned remediation (technical controls, policy update, training, contract amendment, sanctions). For each action, give an owner and a target completion date.

**Output format:** `bullets`


### Section 7: Notification Requirements and Status

**Template section prompt (verbatim from `templates/documents/hipaa-incident-report.yaml`):**

> State whether the incident triggers individual notification (within 60 days), HHS OCR notification (60 days for breaches < 500, no later than 60 days following calendar-year end for breaches < 500 cumulative; immediate for breaches ≥ 500), media notification (≥ 500 individuals in a state/jurisdiction), business associate notification, and any state-specific obligations (e.g., HITECH preemption analysis). For each, give the notification date or the planned target.

**Output format:** `table`


### Section 8: Lessons Learned and Policy Updates

**Template section prompt (verbatim from `templates/documents/hipaa-incident-report.yaml`):**

> Capture what the incident teaches the organization about its controls, training, monitoring, and incident response. List specific policy, procedure, or technology changes resulting from the incident. Tie each change to the root cause it addresses.


### Section 9: Approval and Closure

**Template section prompt (verbatim from `templates/documents/hipaa-incident-report.yaml`):**

> Record sign-off from the Privacy Officer, Security Officer, and (where applicable) General Counsel. State the closure criteria, the actual closure date, and the retention period for the incident record (typically 6 years from creation or last modification under HIPAA).

