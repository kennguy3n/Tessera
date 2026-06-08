# Prompt log — Grant Proposal — After-School STEM Expansion

- **Persona:** Sofia Alvarez, Development Director, Riverside Youth Coalition
- **Template:** `templates/documents/grant-proposal.yaml` (Grant Proposal)
- **Model:** llama3.2:3b (local, via Ollama)
- **Input source files:** 01-program-notes-and-outcomes.md, 02-funder-rfp-and-board-context.md

Tessera runs each template section prompt below against the source files, grounded locally. The generated output is in the matching `outputs/` file.

### Section 1: Cover Page and Abstract

**Template section prompt (verbatim from `templates/documents/grant-proposal.yaml`):**

> Applicant organization, project title, funding opportunity and CFDA / FOA number, requested amount, project period, principal investigator / project director, authorizing official, and a 250-word abstract usable in the public award announcement.


### Section 2: Statement of Need

**Template section prompt (verbatim from `templates/documents/grant-proposal.yaml`):**

> Establish the problem the project addresses: who is affected, the scale and severity of the need, supporting data and citations, and the gap in existing services or knowledge. Tie the need directly to the funder's stated priorities.


### Section 3: Project Description and Goals

**Template section prompt (verbatim from `templates/documents/grant-proposal.yaml`):**

> State the project's overarching goal, specific objectives (SMART format), the target population and inclusion criteria, the geographic service area, and the project's theory of change connecting activities to outcomes.


### Section 4: Methodology and Activities

**Template section prompt (verbatim from `templates/documents/grant-proposal.yaml`):**

> Describe the planned activities, why they are evidence-based (cite the supporting research or prior pilots), the staffing model, partner organizations, and how the project will reach the target population.


### Section 5: Work Plan and Timeline

**Template section prompt (verbatim from `templates/documents/grant-proposal.yaml`):**

> Quarterly or monthly work plan: activity, milestone, deliverable, responsible role, and dependencies. Include start-up activities, the project execution phase, and the close-out / sustainability period.

**Output format:** `table`


### Section 6: Organizational Capacity

**Template section prompt (verbatim from `templates/documents/grant-proposal.yaml`):**

> Describe the applicant organization's mission, history, relevant prior projects, key personnel qualifications, and organizational infrastructure (financial systems, HR, reporting). Address any capacity gaps and how they will be filled.


### Section 7: Evaluation Plan

**Template section prompt (verbatim from `templates/documents/grant-proposal.yaml`):**

> Logic model linking inputs → activities → outputs → outcomes → impact. Identify the performance measures (process and outcome), data collection methods, frequency, the evaluator (internal or third-party), and how findings will be used for continuous improvement.


### Section 8: Budget and Budget Justification

**Template section prompt (verbatim from `templates/documents/grant-proposal.yaml`):**

> Itemized budget by category (personnel, fringe, travel, equipment, supplies, contractual, other, indirect) with year-by-year amounts. Provide a written justification for every line item, calculation method (e.g., FTE × salary × months × fringe rate), and the basis for any cost-share or matching funds.

**Output format:** `table`


### Section 9: Sustainability Plan

**Template section prompt (verbatim from `templates/documents/grant-proposal.yaml`):**

> How the project will be sustained beyond the grant period: diversified funding strategy, fee-for-service revenue, partnerships, policy advocacy for ongoing public support, and which project elements will continue versus sunset.


### Section 10: Required Attachments

**Template section prompt (verbatim from `templates/documents/grant-proposal.yaml`):**

> Checklist of required attachments per the funding opportunity: letters of support, MOUs / MOAs with partners, IRS determination letter, audited financials, board roster, indirect-cost rate agreement, biosketches for key personnel, and any data-management plan.

**Output format:** `bullets`

