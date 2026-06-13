# Tessera — Development Plan to Top-Tier, Highly-Polished Product

> **Status: DELIVERED (historical plan, kept for reference).** Everything this
> plan set out to do has shipped to `main`. This document is the *original
> pre-work plan and current-state snapshot from before the work began* — the
> present-tense "isn't shipped / not yet wired / 10 providers" framing below
> describes the **starting point**, not today's product. Do not read §1 as a
> description of what currently ships.
>
> **What actually shipped since this plan was written:**
> - **Knowledge-browser UI** — Memory page (`/memory`), concept-graph panel,
>   and the enriched "Knowledge" citation tab are all wired, reachable from
>   nav + command palette, and validated in CI (PRs #127–#132, #144, #149,
>   #155). The "built but not wired / staged in a follow-up branch" caveat is
>   gone.
> - **Private-dep CI unblocked** — the `kennguy3n/knowledge` git dependency is
>   fetched in CI over a read-only deploy key; the full Rust matrix is green on
>   PRs (no longer "validated locally only").
> - **Connector ecosystem** — grown from 10 to **31 read-only, least-privilege
>   providers** with a documented add-a-connector recipe (`docs/CONNECTORS.md`)
>   and a per-target/`connectorConfig` seam. (Per-subdomain providers such as
>   Zendesk are tracked separately as they need a per-instance OAuth URL seam.)
> - **Editors** — Document/Sheet/Slide/Base editors brought to Google Docs /
>   Sheets / Slides / Airtable-level functionality with on-device AI (PRs
>   #152/#154/#156/#157 + follow-ons).
> - **Workspace** — Obsidian-style split-panes + tabs, session restore,
>   open-in-new-tab/split, stacked/linked panes (#151, #158).
> - **Quality bar** — enforced perf budgets, an a11y audit pass across all
>   pages, and visual-regression snapshots, all wired into CI (#167).
> - **Honest showcase** — seeding redone against the new capabilities and
>   blogs/scorecard refreshed with genuine screenshots (#137, #143, #163).
>
> The sections below are preserved verbatim as the original plan/baseline.

---

*Scope (original): take Tessera from "knowledge substrate ships as a backend +
a stale, unwired browsing UI, with a 10-provider connector set" to a shipped,
discoverable, polished knowledge plane with a credibly broad connector
ecosystem.*

This plan addressed the two gaps called out directly **at the time** (both now
closed — see the status banner above):

1. **The knowledge-browser UI isn't shipped.** The substrate (observations,
   memory, concept graph) ships as a backend with search, source-health,
   backup, and signed-export surfaces — but the dedicated **Memory page**,
   **concept-graph panel**, and enriched **"Knowledge" citation tab** are
   built and tested, *not yet wired into the shipping renderer*.
2. **Ecosystem breadth.** Connectors v2 (Drive, OneDrive/SharePoint, Notion,
   Jira, Confluence, Figma, HubSpot, Slack, Email/Gmail, GitHub) is growing
   but far smaller than the integration catalogs of Notion / Google /
   Microsoft.

---

## 1. Current-state assessment (baseline snapshot — verified against `main` *at the start of this plan*; now superseded, see status banner)

### 1a. Knowledge substrate — what actually ships vs. what is staged

**Ships on `main` (data plane is complete and wired):**

- Native engines via `crates/tessera_substrate` over the upstream `knowledge`
  crate: observation extraction, decay-based memory, concept graph, synthesis.
- Full IPC surface registered in `apps/desktop/electron/ipc/substrate.ts` and
  exposed through `apps/desktop/electron/preload.ts`:
  `substrate:extractObservations`, `getMemories`, `pinMemory`, `unpinMemory`,
  `forgetMemory`, `getConceptGraph`, `suggestRelatedSources`, `runDecaySweep`,
  `triggerSynthesis`, plus `sources:searchEnriched`.
- Typed renderer contract: `SubstrateApi`, `SubstrateMemoryInfo`,
  `SubstrateConceptInfo`, `EnrichedSearchResult`, etc. in
  `apps/desktop/shared/types.ts`.
- User-facing surfaces already shipped: Settings → Search (hybrid + recency
  half-life), embedding-model selection, Source Health, Backup & Recovery,
  home-screen backup indicator, Export Evidence Pack (ML-DSA-65 signatures),
  and concept-graph-driven "related source" suggestions in Create
  (`useSources.ts` → `substrate:suggestRelatedSources`).

**Built + unit-tested but NOT mounted in the shipping renderer:**

- `components/CitationPanel.tsx` contains a full **"Knowledge" tab**
  (`KnowledgeResultsView`, entities/facts/concepts with decay state) backed by
  `sources:searchEnriched`. It is exercised only by
  `__tests__/citationPanelKnowledgeTab.test.tsx` — **`CitationPanel` is not
  imported by any editor or page** (confirmed: zero references in
  `renderer/src/editors/` or `renderer/src/pages/`).

**Staged in a follow-up branch — `origin/devin/1781125029-ui-memory-concept-graph`:**

- `pages/MemoryPage.tsx` (~332 LOC) — browse/pin/unpin/forget memories.
- `components/ConceptGraphPanel.tsx` (~592 LOC) + `utils/conceptGraph.ts`
  (~385 LOC) — concept-graph visualization/layout.
- `pages/KnowledgePage.tsx`, HomePage knowledge insights (+112 LOC),
  `SourceDetailPage.tsx` substrate section (+52 LOC), `navigation.ts` updates.
- Tests: `memoryPage.test.tsx`, `conceptGraphPanel.test.tsx`,
  `conceptGraph.test.ts` (+ snapshot).

> **Critical caveat:** that branch is **stale**. Its merge-base with `main` is
> ~49 commits back (2026-06-10); `main` has 49 commits the branch lacks, and
> the branch has 13 commits that pre-date major `main` work (it still deletes
> `crypto.rs`, the showcase series, migration `0006`, etc. that now live on
> `main`). **It cannot be merged directly.** The UI must be cherry-picked /
> re-applied onto current `main`, reconciled with the renderer as it exists
> today (navigation tiering, `CitationPanel` already on `main`, current shared
> types), and re-tested.

### 1b. Connector ecosystem

- **v2 framework** (`crates/tessera_bridge/connectors_v2.rs`, wrapping the
  upstream `knowledge` connector framework) is default-on (`useV2Connectors`)
  and ships **10 providers**: Google Drive, OneDrive/SharePoint, Notion, Jira,
  Confluence, Figma, HubSpot, Slack, Email/Gmail, GitHub.
- **v1 legacy** (`crates/tessera_connectors`) implements 6 of those as a
  reversible fallback.
- Renderer descriptors (`components/connectorDescriptors.ts`) cover the same
  10. This is solid engineering but, as stated, **far smaller** than the
  hundreds of integrations in Notion / Google / Microsoft catalogs.

### 1c. The cross-cutting blocker: private dependency in CI

`kennguy3n/knowledge` is a **private git dependency**. CI cannot clone it and
**fails at the fetch step**, so substrate-touching changes are currently
validated *locally only* (`cargo +1.88 fmt/clippy/test`, desktop
`lint`/`type-check`/`test`). **Shipping the knowledge UI through CI is blocked
until this is resolved** (a branch `origin/devin/1781147941-ci-knowledge-deploy-key`
exists as a starting point). This is sequenced first because every other
substrate workstream depends on green CI.

---

## 2. Definition of "top-tier and highly polished"

A surface is "shipped and polished" only when it clears this bar:

- **Wired & discoverable:** reachable from primary navigation / editor, not
  just present in the bundle.
- **Real data, gracefully degrading:** populated empty states, loading
  skeletons, and error boundaries; never a blank panel or a crash when the
  substrate is empty or the bridge is unavailable.
- **Interactive & performant:** stays responsive at realistic scale (10k+
  memories, 5k+ concept-graph nodes) via virtualization / node capping.
- **Accessible:** keyboard-navigable, ARIA-labeled, passes the existing
  `accessibility.test.tsx` bar; respects dark-mode tokens.
- **Consistent:** uses existing `Card`/`Button`/`EmptyState`/`Toast`/
  `PageHeader` primitives and the command palette / keyboard-shortcut system.
- **Covered:** unit + integration tests, and validated through **CI**, not
  just locally.
- **Documented:** ARCHITECTURE / README / CHANGELOG / showcase updated so the
  "what ships today" line moves honestly.

---

## 3. Workstreams

The work splits into four parallelizable workstreams (A–D) plus a sequencing
plan in §4. Each phase lists concrete deliverables and acceptance criteria.

### Workstream A — Land the knowledge-browser UI (the headline gap)

**A0. Unblock CI for substrate code** *(prerequisite — see §1c)*
- Pick one of: deploy key + `git config insteadOf`, git submodule, vendored
  crate, or a private cargo registry. Recommended: **read-only deploy key**
  injected as a CI secret (lowest churn, matches the existing branch).
- Acceptance: a substrate-touching PR runs `cargo build/clippy/test` green in
  CI on the GitHub-hosted runners.

**A1. Reconcile the staged UI onto current `main`**
- Cherry-pick / re-apply `MemoryPage.tsx`, `ConceptGraphPanel.tsx`,
  `conceptGraph.ts`, `KnowledgePage.tsx`, HomePage insights, SourceDetail
  section, and their tests from `1781125029-ui-memory-concept-graph`.
- Drop the branch's stale deletions; rebase onto the current renderer
  (navigation tiering, existing `CitationPanel`, current `shared/types.ts`).
- Acceptance: components compile against today's `SubstrateApi`; all ported
  tests pass; no regression to existing renderer tests.

**A2. Wire the enriched "Knowledge" tab into editors**
- Mount `CitationPanel` (already on `main`) in the artifact editors
  (`ArtifactEditorPage` / `BaseEditor`) so the Knowledge tab is reachable from
  a real editing session — not just from tests.
- Acceptance: opening citations in a Doc/Sheet/Slides/Base editor shows the
  Sources/Knowledge tabs; selecting Knowledge lists entities/facts/concepts for
  the query with correct empty/loading/error states.

**A3. Ship the Memory page**
- Add `MemoryPage` to routing + the secondary navigation tier in
  `navigation.ts` (preserving the `Ctrl/Cmd+N` shortcut-index invariant the
  file documents and `navigation.test.ts` enforces).
- Features: list/filter memories by scope, observation type, and decay state;
  pin/unpin/forget with optimistic UI + toast; sort by retention; virtualized
  list for large scopes; "run decay sweep" / "trigger synthesis" actions
  surfaced where appropriate.
- Acceptance: page is reachable, populated from `substrate:getMemories`,
  mutations round-trip, empty/error states present, a11y + dark-mode pass.

**A4. Ship the concept-graph panel**
- Mount `ConceptGraphPanel` (from `MemoryPage`/`KnowledgePage` and/or
  `SourceDetailPage`), backed by `substrate:getConceptGraph` (JSON
  `GraphView`).
- Polish: node-count cap with "show more", zoom/pan, click-through to source,
  relationship-type legend (is_a / part_of / supersedes / contradicts),
  performance guard at large node counts.
- Acceptance: renders a real graph for a multi-source scope, interactive,
  degrades gracefully on empty/huge graphs.

**A5. HomePage knowledge insights**
- Surface substrate signals on Home beyond backup/source health: top
  reinforced memories, recent concepts, "N sources about X" nudges.
- Acceptance: insights render from live data with empty-state fallback.

**A6. Honesty pass on docs**
- Update `docs/showcase/blog/07-knowledge-plane.md` ("What ships today"),
  `docs/COMPETITIVE_SCORECARD.md`, `ARCHITECTURE.md`, `README.md`, and
  `CHANGELOG.md` to reflect that the browsing UI now ships. Capture fresh
  screenshots to replace the "staged" disclaimer.

### Workstream B — Connector ecosystem (breadth + depth)

The honest framing: we will not out-catalog Notion/Google/Microsoft on raw
count. The strategy is **(i) depth on the existing 10, (ii) a credible next
tranche of high-value providers, and (iii) lowering the per-connector cost so
breadth compounds.**

**B1. Depth & trust on the current 10**
- Per-connector: incremental/delta sync correctness, deletion detection,
  token-refresh resilience, rate-limit/backoff (`retry.rs`,
  `failure_state.rs`), and clear failure surfaced in `ConnectorStatus`.
- Scope transparency (`connectors:inspectScopes`) shown in the connect modal
  so users see exactly what each connector reads.
- Acceptance: each provider has a lifecycle smoke test (extend
  `tests/smoke_connectors.rs`) and a documented sync model.

**B2. Reduce the cost of adding a connector**
- Factor the common OAuth2 + paginated-fetch + content-normalization path so a
  new read-only provider is a small descriptor + a thin fetch adapter, not a
  new bespoke module. The `connectors_v2` `ConnectorKind` mapping +
  `RemoteConnector` trait already point this way — formalize it into a
  documented "add a connector" recipe in `CONTRIBUTING.md`.
- Acceptance: a documented, ≤1-day path to add a standard REST/OAuth provider.

**B3. Next provider tranche (prioritized by user demand)**
- Tier 1 (high demand, standard OAuth): Microsoft Teams, Outlook/Exchange
  mail, Google Calendar/Gmail expansion, Dropbox, Box, Asana, Linear, Trello,
  GitLab, Zendesk.
- Tier 2: Salesforce, ServiceNow, Airtable, ClickUp, Monday, Intercom, Gmail
  threads, SharePoint sites (beyond OneDrive files).
- Each lands behind a cargo feature + a descriptor; ship in small batches so
  CI stays green and each gets a smoke test.
- Acceptance: target ~25–30 providers within the plan horizon, each with
  sync + tests, with the recipe making further growth cheap.

**B4. Connector UX polish**
- A searchable connector gallery (categories: Storage, Docs/Wiki, Chat, CRM,
  Issues, Calendar/Mail), per-connector health + last-sync, one-click reauth,
  and clear "what we read / what we never touch" copy. Connected content flows
  through evidence → observation → memory (already the v2 design), so new
  connectors immediately enrich the knowledge plane.

### Workstream C — Cross-cutting quality & polish bar

**C1. Performance at scale**
- Bench Memory page + concept-graph panel at 10k memories / 5k nodes; add
  virtualization and node capping where needed; extend the existing cold-start
  / scale-bench CI gates to cover the new surfaces.

**C2. Accessibility & theming**
- Extend `accessibility.test.tsx` and `darkModeTokens.test.ts` coverage to the
  new pages/panels; full keyboard nav; command-palette entries for Memory /
  Knowledge; shortcut-hint chips.

**C3. Resilience & empty states**
- Error boundaries around the new pages (consistent with the per-editor
  boundaries writing `crash-report.json`); first-run empty states that explain
  how the substrate populates (index a source → run observations).

**C4. Onboarding & progressive disclosure**
- Fold the knowledge surfaces into the onboarding wizard and "More tools"
  tier so new users discover Memory/Knowledge without being overwhelmed
  (respect the existing `simplifiedNav` default).

### Workstream D — Product-level polish (top-tier feel)

- End-to-end flow review: source → observations → memory → concept graph →
  cited artifact → signed export, with friction removed at each hop.
- Visual consistency sweep (spacing, iconography via `iconResolver`, empty-
  state illustrations, toasts).
- Telemetry-free quality signals: in-app "what's new" for the knowledge plane;
  refreshed showcase screenshots and a UI walkthrough post update.

---

## 4. Sequencing & milestones

Workstreams B and D can run in parallel with A from the start. A0 gates the
rest of A.

| Milestone | Contents | Exit criteria |
|---|---|---|
| **M0 — Unblock** | A0 (CI private-dep), B2 (connector recipe) | substrate PRs go green in CI; connector recipe documented |
| **M1 — Knowledge UI shipped** | A1–A4 | Memory page, concept-graph panel, and Knowledge tab reachable in the app, green in CI |
| **M2 — Insights & honesty** | A5, A6, C2–C3 | Home insights live; docs/showcase updated; a11y + error boundaries done |
| **M3 — Connector depth** | B1, B4 | existing 10 connectors hardened + gallery UX |
| **M4 — Connector breadth** | B3 (tranches) | ~25–30 providers, each tested |
| **M5 — Polish** | C1, C4, D | scale benches pass; onboarding + visual sweep complete |

Each milestone is a small series of focused PRs (one surface per PR) rather
than a single large branch — this keeps CI green and review tractable, and
avoids recreating the "one giant stale branch" problem that left the current
UI unmerged.

---

## 5. Risks & mitigations

- **Private-dep CI (highest risk).** Everything in A is gated on it. Mitigate
  by doing A0 first and confirming a substrate PR is green before porting UI.
- **Stale UI branch drift.** Re-apply onto `main` surface-by-surface with
  tests, rather than merging the branch. Treat the branch as a reference
  implementation, not a merge source.
- **Connector breadth vs. quality.** Resist shipping shallow connectors for
  count. The recipe (B2) + per-connector smoke tests (B1/B3) keep quality
  constant as breadth grows.
- **Scope/security surface.** Each new connector widens OAuth scope exposure;
  keep `inspectScopes` transparency and least-privilege scopes per provider.
- **Performance regressions** on graph/memory views at scale — covered by C1
  benches wired into the existing CI gates.

---

## 6. Success metrics

- **Shipped:** Memory page, concept-graph panel, and Knowledge citation tab
  are reachable in a fresh install and validated in CI (not just locally).
- **Honest line moves:** post 7 / scorecard no longer carry the "built but not
  wired" disclaimer.
- **Discoverability:** knowledge surfaces reachable via nav + command palette;
  onboarding introduces them.
- **Ecosystem:** ~25–30 connectors, each with sync + tests, plus a documented
  ≤1-day path to add more.
- **Quality bar held:** a11y, dark-mode, error-boundary, and scale-bench gates
  green across all new surfaces.
