# Maya has five days and a stolen laptop: a defensible HIPAA breach assessment

_Part 1 of the Tessera showcase series — Healthcare._

> **Persona:** Maya Okonkwo, Clinical Privacy Officer, Mercy Ridge Health (410-bed regional
> health system)
> **The task:** turn a stolen-laptop helpdesk ticket into a defensible four-factor HIPAA
> breach risk assessment within five business days.
> **Artifacts:** HIPAA Incident Report (document) + Privacy Incident Tracker (base)

## The situation

On a Tuesday morning, ticket **INC-4471** lands in Maya's queue: a nurse's work laptop was
stolen overnight from a car. The laptop held an Excel export from the EHR — a patient list
for a Saturday infusion clinic, roughly **220 patients**. The device was not encrypted; a
BitLocker policy exception from September had never been remediated.

Maya now has a regulatory clock running. Under the HITECH Act she needs a four-factor risk
assessment and a breach-vs-incident determination, and she has a few business days to
produce something a regulator — and her General Counsel — will accept.

The catch: the only way to write this report is to work _with_ the most sensitive data in
the building. PHI. That material can never go to a cloud AI service. This is precisely the
constraint Tessera is built for.

## The inputs

Maya points Tessera at the folder for this incident. Four files:

- [`01-helpdesk-ticket-INC-4471.md`](../artifacts/healthcare/inputs/01-helpdesk-ticket-INC-4471.md) — the IT service-desk ticket and timeline.
- [`02-endpoint-mdm-report.md`](../artifacts/healthcare/inputs/02-endpoint-mdm-report.md) — the MDM/endpoint audit showing the device was unencrypted.
- [`03-ehr-export-log.md`](../artifacts/healthcare/inputs/03-ehr-export-log.md) — the Epic "Clarity" export log proving what data left the EHR.
- [`04-policy-and-context.md`](../artifacts/healthcare/inputs/04-policy-and-context.md) — the internal breach-response policy (POL-PRIV-014) and roles.

## The work

Maya picks the **HIPAA Incident Report** template and selects those four files as sources.
The template isn't a single prompt — it's a structured set of sections, each with its own
instruction. For the risk assessment section, Tessera sends the model this _verbatim_
prompt (from [`prompts/hipaa-incident-report.md`](../artifacts/healthcare/prompts/hipaa-incident-report.md)):

> Document the four-factor risk assessment required by the HITECH Act: (1) the nature and
> extent of the PHI involved, including types of identifiers and likelihood of
> re-identification; (2) the unauthorized person who used or received the PHI; (3) whether
> the PHI was actually acquired or viewed; (4) the extent to which risk has been mitigated.
> Conclude with the breach-vs-incident determination and the rationale.

The model drafts each section against Maya's four files only.

## The result

![HIPAA incident report in the Tessera document editor](../assets/screenshots/healthcare-document-hipaa.png)

A complete, **12-section** incident report — Incident Summary, Discovery Timeline, Affected
Individuals & PHI Categories, the four-factor Risk Assessment, Root Cause Analysis,
Containment & Remediation, Notification Requirements, Lessons Learned, and Approval &
Closure. ~1,700 words, structured exactly the way a privacy officer would defend it.

Note the details that came straight from her sources: the **45 CFR §164.402** breach
classification, the ~220 affected patients, the police report number, the unencrypted-device
finding, and a notification-requirements table that distinguishes individual notice, HHS OCR
timing, and state obligations. The inline `[02-endpoint-mdm-report.md]`-style markers show
the model citing the source behind each claim.

The document editor itself is a full writing surface, not a read-only render: a
**table-of-contents block** anchors the report, the lead paragraph is promoted to a
**callout**, a detail-heavy section folds into a **toggle**, and the right-hand **outline
panel** tracks your scroll position with a reading-time estimate. An on-device AI writing
assistant (rewrite / shorten / expand / change tone / continue) is one keystroke away — and
like everything else here, it runs on Maya's machine.

The full generated document is in
[`outputs/hipaa-incident-report.md`](../artifacts/healthcare/outputs/hipaa-incident-report.md).

### The companion: a privacy incident tracker

Maya also needs to see this incident in the context of the others she's tracking. The same
sources, run through a **base** template, produce a structured Privacy Incident Tracker:

![Privacy incident tracker in the Tessera base editor](../assets/screenshots/healthcare-base-tracker.png)

This is a **multi-table base**, not a flat grid. The **Incidents** table carries typed
fields — Incident ID, Date Discovered (date), Severity, Status, Individuals Affected
(number), and an **Encrypted checkbox** — and links to a second **Owners** table through a
cross-table **linked-record** field. From that link the grid derives an **Owner Role
lookup**, a **Reportable formula** (`IF({Individuals Affected} >= 500, …)`), and a **Risk
Score rating**, while the Owners table **rolls up** each owner's open-incident count and
total individuals affected. INC-4471 sits at the top — classified, severity High, 220
individuals, unencrypted.

![Expanding the INC-4471 record — comments and an activity timeline in the base editor's expand-record modal](../assets/screenshots/healthcare-base-expand.png)

Opening a record expands it into a full **expand-record modal** with a **comments + activity
timeline** — here, the four-factor assessment discussion on INC-4471. Source JSON:
[`outputs/incident-tracker.json`](../artifacts/healthcare/outputs/incident-tracker.json).

Because a privacy office runs this process again and again, Maya doesn't stop at a grid. She
flips the base into **App mode**: the same records become a small intake-and-triage app — an
app-shell sidebar to move between Incidents and Owners, a **record-detail page** for working one
incident at a time, a runtime **intake form** so a triage colleague can log a new incident
without touching the schema, and a **dashboard** of open-incident counts and
individuals-affected rollups. She then saves the configured tracker as a reusable
**`tessera.basetemplate`**, so the next incident starts from her exact structure instead of a
blank base — all still on her machine, no schema migration, the original grid untouched.

## Why it matters

Maya's deliverable is a legal artifact. The value isn't "the AI wrote it" — it's that the
structure is enforced by the template (she can't accidentally skip the four-factor
analysis), every claim is traceable to a source file, and **the PHI never left her laptop**.
That combination is what makes an AI tool usable in healthcare compliance at all.

**Outcome:** Maya walks away with a 12-section, ~1,700-word report that covers all four HITECH
factors (the template makes skipping one impossible), a breach-vs-incident determination with
rationale ready for GC review, and an 8-record incident tracker with INC-4471 classified — every
claim traceable to one of four source files, the PHI never off her laptop, and the whole package
exportable as a PQC-signed evidence pack a regulator can verify.

---

Next: [David turns a 40-page SaaS contract into a one-page summary →](02-legal-paralegal.md)
