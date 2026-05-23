# Tessera — Product Proposal

---

## Positioning

**General:**
> Tessera is a local-first open-source productivity workspace for creating documents, slides, sheets, and bases from your own files and connected sources.

**Shorter:**
> Tessera is a local-first workspace for turning your knowledge into documents, slides, sheets, and structured bases.

**Developer-facing:**
> Tessera is an open-source desktop productivity workspace powered by a local knowledge substrate, template-driven artifact generation, and optional local model inference.

---

## Product direction

### What users can do

- Connect local folders and files as knowledge sources.
- Connect remote sources: Google Drive, OneDrive/SharePoint, Notion, Jira, Confluence, Figma.
- Index knowledge locally with encrypted storage.
- Create documents, slides, sheets, and bases from templates.
- Generate drafts, outlines, summaries, tables, and plans backed by source citations.
- Keep citations, provenance, and audit history for every artifact.
- Use local models (Bonsai / Ternary-Bonsai) for on-device generation.

### What Tessera is not

- **Not a chat app** — produces structured work artifacts, not conversation threads.
- **Not a messaging client** — no inbox, no contacts list, no real-time messaging.
- **Not a cloud-first assistant** — data stays local by default; remote sources are explicitly connected.
- **Not a general chatbot wrapper** — a productivity workspace, not a chat UI over an LLM API.

### Core promise

> Tessera turns your local and connected knowledge into structured, editable work artifacts.

---

## Core product surfaces

| Surface | Purpose |
|---|---|
| **Home** | Dashboard with recent artifacts, source status, quick actions |
| **Sources** | Manage local and remote knowledge sources |
| **Create** | Launch new artifacts from templates |
| **Documents** | Document editor (PRDs, proposals, SOPs, reports) |
| **Slides** | Slide deck editor (QBRs, strategy, reviews) |
| **Sheets** | Spreadsheet editor (budgets, scorecards, trackers) |
| **Bases** | Structured data editor (vendor register, risk register, roadmap, asset inventory, CRM, incident tracker, employee directory, compliance register) |
| **Infographics** | Visual one-pager editor (stats overview, process flow, comparison, timeline, org chart, KPI dashboard) |
| **Landing pages** | Marketing landing-page editor (SaaS product, nonprofit cause, event / conference, personal & agency portfolio) |
| **Templates** | Browse, create, and manage artifact templates |
| **Tasks / Plans** | Task lists, project plans, launch checklists |
| **Automations** | Scheduled index refreshes, template-triggered workflows |
| **Settings** | Source connections, model runtime config, export defaults, preferences |

There is **no primary chat feed**. Tessera is an artifact-first workspace.

---

## Main workflow

```
Connect sources → Index knowledge → Select template → Create artifact → Review citations → Edit → Export or share
```

---

## Main user workflows

### 1. Add local knowledge

**Flow:** Sources → Add source → Local folder → Select folder → Index

| Step | Detail |
|---|---|
| Watch folder | File watcher detects new, changed, and deleted files |
| Detect changes | Content hashing identifies modified files; unchanged files are skipped |
| Extract text | Text extraction from supported file types |
| Chunk | Content is split into retrievable chunks |
| Store evidence | Chunks stored in encrypted local evidence store with content-hash dedup |
| Search | Hybrid retrieval: FTS5 lexical + `HashTrickEmbedding` vector similarity + temporal recency decay (30-day half-life), fused via Reciprocal Rank Fusion (k=60). Configurable from Settings (hybrid toggle + recency half-life). |
| Ignored files | `.gitignore`-style patterns, binary files, system files |
| Provenance | Every chunk tracks source file path, page/section, extraction timestamp |

**Supported file types:** PDF, DOCX, PPTX, XLSX, CSV, Markdown, TXT, HTML, JSON, Images (with metadata extraction).

### 2. Connect remote sources

**Recommended connection order:** Google Drive → OneDrive/SharePoint → Notion → Jira → Confluence → Figma.

Each remote connector supports:

| Feature | Description |
|---|---|
| OAuth | Standard OAuth 2.0 authorization flow |
| Folder / project selection | User selects which folders, spaces, or projects to sync |
| Incremental sync | Only changed content is re-fetched on subsequent syncs |
| Permission snapshot | Records the user's access permissions at connection time |
| Disconnect / revoke | Clean disconnect removes local index and revokes tokens |
| Connector health | Status indicator showing last sync time and error state |
| Local indexing | Selected remote content is indexed locally using the same pipeline |
| Audit tracking | Connection, sync, and disconnect events logged to audit trail |

**Model:** Remote source access is authorized by the user. Selected content is indexed locally. Artifact creation runs entirely locally.

### 3. Create from template

**Create launcher:**

| Category | Templates |
|---|---|
| **Create** | Document, Slides, Sheet, Base, PRD, Proposal, SOP, QBR, Report, Form |
| **Analyze** | Summarize sources, Compare documents, Extract tasks/risks/decisions, Generate report, Analyze spreadsheet |
| **Plan** | Project plan, Task list, Risk register, Budget, Meeting agenda, Launch checklist |
| **Approve** | Purchase, Budget, Policy exception, Vendor review |

---

## Artifact types

### Documents

PRDs, Proposals, SOPs, Reports, Memos, Meeting notes, Briefs.

- **Editor:** ProseMirror / TipTap-based rich text editor
- **Features:** Rich text, outline panel, inline citations, version history
- **Export:** Markdown, HTML, PDF, DOCX

### Slides

QBRs, Strategy decks, Review presentations, Training decks.

- **Structure:** Deck → Slides → Layout → Blocks → Speaker notes → Citations
- **Features:** Template layouts, chart/table/image slides, speaker notes per slide, citation panel
- **Export:** PDF, PPTX

### Sheets

Budgets, Scorecards, Roadmaps, Trackers, Inventories.

- **Structure:** Workbook → Sheets → Cells → Formulas → Named ranges → Source refs
- **Features:** Grid editor, CSV/XLSX import, formula support, source references per cell
- **Export:** CSV, XLSX

### Bases

Vendor register, Risk register, Roadmap, Decision log, Asset inventory.

- **Structure:** Base → Tables → Fields → Records → Views
- **Views:** Grid, Kanban, Calendar, Timeline, Gallery
- **MVP:** Starts with Grid view
- **Export:** CSV, JSON

---

## Template system

Templates are defined in **YAML** format. Each template specifies the artifact type, required source types, sections, and generation instructions.

### Example: PRD template

```yaml
id: prd-v1
name: Product Requirements Document
type: document
description: Standard PRD with problem, solution, scope, and success criteria
sections:
  - title: Problem Statement
    prompt: >
      Summarize the core problem this product addresses,
      citing relevant source material.
    required_sources:
      - type: local
        min: 1
  - title: Proposed Solution
    prompt: >
      Describe the proposed solution, referencing technical
      constraints and prior art from sources.
  - title: Scope
    prompt: >
      Define what is in scope and out of scope for the
      initial release.
  - title: Success Criteria
    prompt: >
      List measurable success criteria with targets.
  - title: Risks and Mitigations
    prompt: >
      Identify risks and proposed mitigations, citing
      source material where applicable.
export:
  - markdown
  - html
  - pdf
  - docx
```

### Template directory structure

```
templates/
├── documents/
│   ├── prd.yaml                 # generic PRD
│   ├── proposal.yaml            # generic proposal
│   ├── sop.yaml                 # standard operating procedure
│   ├── report.yaml              # analytical report
│   ├── memo.yaml
│   ├── meeting-agenda.yaml
│   ├── meeting-notes.yaml
│   ├── task-list.yaml
│   ├── form.yaml
│   │
│   ├── clinical-protocol.yaml   # ┐ industry-specific variants
│   ├── patient-care-plan.yaml   # │ (healthcare, legal, education,
│   ├── legal-brief.yaml         # │  government, finance,
│   ├── contract-summary.yaml    # │  manufacturing, retail,
│   ├── lesson-plan.yaml         # │  nonprofit, creative,
│   ├── course-syllabus.yaml     # │  real estate)
│   ├── policy-brief.yaml        # │
│   ├── grant-proposal.yaml      # │  Each carries `industry:` and
│   ├── investment-memo.yaml     # │  optionally `profile:` tags so
│   ├── audit-findings.yaml      # │  the CreatePage industry filter
│   ├── quality-control-report   # │  surfaces them per user.
│   ├── content-calendar.yaml    # │
│   ├── brand-guidelines.yaml    # │  See README.md "Industry
│   ├── campaign-brief.yaml      # │  coverage" for the full list.
│   ├── property-analysis.yaml   # │
│   └── …                        # ┘
│   │
│   └── locales/                 # nine non-English locales × top 10
│       ├── es/                  # templates (PRD, proposal, SOP,
│       ├── fr/                  # report, meeting agenda, meeting
│       ├── de/                  # notes, task list, form). Section
│       ├── ja/                  # titles + prompts translated;
│       ├── zh/                  # prompts ask the model to respond
│       ├── pt/                  # in the target language. Ids share
│       ├── ko/                  # the base id with a `-<locale>`
│       ├── ar/                  # suffix (e.g. `prd-v1-es`).
│       └── hi/
├── slides/
│   ├── qbr.yaml                 # baseline corporate decks
│   ├── strategy.yaml
│   ├── review.yaml
│   ├── training.yaml
│   ├── pitch.yaml               # founder / sales pitch deck
│   ├── onboarding.yaml          # employee onboarding deck
│   ├── sales-enablement.yaml    # sales enablement / demo deck
│   ├── board-update.yaml        # board quarterly update
│   ├── investor-update.yaml     # monthly / quarterly investor update
│   ├── workshop.yaml            # workshop / facilitation deck
│   └── locales/                 # localized pitch deck (es..hi)
├── sheets/
│   ├── budget.yaml
│   ├── scorecard.yaml
│   ├── roadmap.yaml
│   ├── tracker.yaml
│   ├── inventory.yaml
│   ├── product-catalog.yaml     # retail / e-commerce
│   ├── sales-forecast.yaml      # retail / e-commerce
│   └── locales/                 # localized budget (es..hi)
├── bases/
│   ├── vendor-register.yaml
│   ├── risk-register.yaml
│   ├── decision-log.yaml
│   ├── roadmap.yaml
│   ├── asset-inventory.yaml
│   ├── crm.yaml                 # simple CRM with pipeline stages
│   ├── incident-tracker.yaml    # severity / status / resolution
│   ├── employee-directory.yaml  # HR org directory
│   └── compliance-register.yaml # obligations + evidence + owner
├── infographics/
│   ├── comparison.yaml          # legacy visual schema
│   ├── process-flow.yaml        # legacy visual schema
│   ├── stats-overview.yaml      # legacy visual schema
│   ├── timeline.yaml            # canonical schema
│   ├── org-chart.yaml           # canonical schema
│   └── kpi-dashboard.yaml       # canonical schema
└── landing_pages/
    ├── saas-product.yaml        # legacy visual schema
    ├── nonprofit.yaml           # nonprofit / cause landing
    ├── event.yaml               # event / conference registration
    └── portfolio.yaml           # personal / agency portfolio
```

The registry is enforced by
`crates/tessera_templates/tests/bundled_templates.rs`, which discovers
every YAML on the filesystem, parses + validates it, asserts unique
ids, checks that every locale variant lives in a matching
`locales/<code>/` directory, and verifies that every supported
non-English locale ships the full canonical 10-template set.

---

## Source and citation model

### Citation format

```json
{
  "citation_id": "cit_a1b2c3d4",
  "source_id": "src_x9y8z7w6",
  "source_type": "local_file",
  "source_title": "Q4 Planning Brief.pdf",
  "source_uri": "file:///Users/alice/Documents/planning/Q4-brief.pdf",
  "chunk_hash": "blake3:abc123def456",
  "page": 4,
  "confidence": 0.92,
  "used_for": "Problem Statement",
  "created_at": "2026-01-15T10:30:00Z"
}
```

### Citation features

| Feature | Description |
|---|---|
| Click to open source | Opens the original file or remote source |
| Show excerpt | Displays the relevant text excerpt from the source |
| Show file path | Full local path or remote URI |
| Show page / section | Page number or section heading in the source |
| Show confidence | Retrieval confidence score |
| Show if source changed | Flags if the source file has been modified since the citation was created |
| Allow replacement | User can swap a citation for a different source |
| Allow removal | User can remove a citation entirely |

---

## Local model runtime

### Model tiers

| Tier | Model | Parameters | Use case |
|---|---|---|---|
| Lightweight | Ternary-Bonsai 1.7B | 1.7B | Quick drafts, extraction, tagging |
| Balanced | Ternary-Bonsai 4B | 4B | Normal generation |
| Higher quality | Ternary-Bonsai 8B | 8B | Longer reports, complex artifacts |

### Runtime design

```
Electron main → starts sidecar → checks health → sends generation jobs → streams output
```

The renderer does **NOT** manage model binaries, tokens, filesystem, or storage. All model interaction goes through the Electron main process and the Rust core engine.

---

## Compute modes

| Mode | Description |
|---|---|
| **Local** | All processing on-device, no network |
| **Local with connected sources** | Local processing + authorized remote source sync |
| **Remote connector sync** | Periodic sync of remote source content to local index |
| **Optional external provider** | External LLM API (disabled by default) |

**MVP default:** Local by default. Remote only when explicitly connected by the user. External providers disabled unless configured in Settings.

---

## Naming system

### Repository names

| Repo | Purpose |
|---|---|
| `tessera` | Monorepo or meta repo |
| `tessera-desktop` | Electron desktop application |
| `tessera-core` | Rust core engine |
| `tessera-templates` | Template library |
| `tessera-connectors` | Source connector plugins |

### Package names

| Package | Registry |
|---|---|
| `@tessera/desktop` | npm |
| `@tessera/ui` | npm |
| `@tessera/templates` | npm |

### Rust crate names

| Crate | Purpose |
|---|---|
| `tessera_core` | Core engine |
| `tessera_bridge` | N-API bridge to Electron |
| `tessera_connectors` | Connector framework |
| `tessera_export` | Export engine |

---

## Main risks

| Risk | Mitigation |
|---|---|
| Electron app size | Offload heavy work to Rust core and sidecars; tree-shake renderer |
| Connector complexity | Start with local sources, then add one remote connector at a time |
| Export fidelity | Start with Markdown/HTML/PDF/CSV; add DOCX/PPTX/XLSX incrementally |
| Model runtime packaging | Platform-specific sidecar binaries; separate download from app install |
| Data trust | Local-first defaults, encrypted storage, audit logs, revocation support |
| Template quality | Versioned templates, user-editable, source-aware prompts |

---

## Design system

Tessera's UI follows the **KChat design system**.

| Token | Value |
|---|---|
| **Primary accent** | `#7C3AED` (Purple/Violet) — headlines, CTA buttons, active states, links, icons |
| **Primary hover** | `#6D28D9` (darker violet) |
| **Background – page** | `#FFFFFF` (white) |
| **Background – card/surface** | `#F5F3FF` (light lavender) or `#F9FAFB` (light gray) |
| **Text – headline** | `#111827` (near-black) |
| **Text – body** | `#4B5563` (dark gray) |
| **Text – secondary** | `#6B7280` (medium gray) |
| **Font family** | `Inter` (primary), system sans-serif fallback stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` |
| **Primary button** | Solid `#7C3AED` background, white text, pill/rounded shape (`border-radius: 9999px`) |
| **Secondary button** | Outlined with `#111827` border, dark text, uppercase tracking |
| **Cards** | White `#FFFFFF` background, `border-radius: 12px`, subtle shadow `0 1px 3px rgba(0,0,0,0.1)` |
| **Overall feel** | Clean, modern, minimal — purple dominant against white/light surfaces |

---

## Links

- [README.md](README.md) — project overview
- [ARCHITECTURE.md](ARCHITECTURE.md) — technical architecture
- [PROGRESS.md](PROGRESS.md) — phased delivery tracker
- [kennguy3n/knowledge](https://github.com/kennguy3n/knowledge) — local knowledge substrate
