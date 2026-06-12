# An honest assessment: Tessera vs. the alternatives

*Part 8 of the Tessera showcase series — competitive reality check.*

A showcase that only lists strengths isn't evidence, it's a brochure. This post does the
opposite: it puts Tessera next to the tools a buyer is actually weighing, says plainly where
each of those tools is **better**, and is specific about where Tessera **loses today**. The
goal is the same as the rest of the series — earn trust by showing the gap, not hiding it.

For the engineering-level scorecard behind these claims, see
[`docs/COMPETITIVE_SCORECARD.md`](../../docs/COMPETITIVE_SCORECARD.md) and the architecture
decisions in [`docs/adr/`](../../docs/adr).

## The four things people compare Tessera to

1. **Cloud AI assistants** — ChatGPT, Claude (incl. Claude Projects), Gemini, Microsoft 365
   Copilot, NotebookLM.
2. **Cloud-first workspaces with AI** — Notion AI, Coda AI, Google Workspace + Gemini.
3. **Local-first / on-device knowledge tools** — AnythingLLM, GPT4All, LM Studio, Jan, Khoj,
   Reor, Obsidian with AI plugins.
4. **DIY** — run a local model yourself and prompt it by hand.

Tessera lives in category 3 by architecture, but it's bought *against* categories 1 and 2,
because that's where the buyer's budget and habits already are.

## The honest comparison table

| Dimension | Cloud assistant | Cloud workspace + AI | Local RAG tools | **Tessera** |
|-----------|-----------------|----------------------|-----------------|-------------|
| Data location | Vendor cloud | Vendor cloud | **Your device** | **Your device** |
| Inference location | Vendor cloud | Vendor cloud | **Your device** | **Your device** |
| Usable with PHI / privileged / NPI | Usually blocked by policy | Usually blocked | Yes | **Yes — the design point** |
| Raw model quality (prose) | **Best (frontier)** | **Strong** | Varies | Good, small on-device model |
| Structured deliverables (doc/slides/sheet/base) | Chat text | **Native + AI add-on** | Mostly chat/notes | **Four first-class editors** |
| Source grounding | You paste context | Workspace-scoped | **Yes (RAG)** | **You select sources; output cites them** |
| Inline per-claim citations | Rare | Limited | Sometimes | **Built-in, per-section** |
| Structure enforcement | None | Some | None | **Template sections enforce completeness** |
| Real-time multi-user collaboration | N/A | **Excellent** | No | **No (KChat for async)** |
| Ecosystem / integrations breadth | **Large** | **Large** | Small | Growing (connectors v2) |
| Verifiable export provenance | No | No | Rare | **PQC-signed evidence pack** |
| Cost model | Per-seat + usage | Per-seat | Free/OSS | **OSS, no per-token cost** |
| Auditability | Closed | Closed | Varies | **MIT-licensed, inspectable** |

## Where the competition is genuinely better

**Cloud assistants (ChatGPT / Claude / Gemini / Copilot) win on raw model quality.** A frontier
hosted model writes more fluent, more capable prose than Tessera's small on-device
Ternary-Bonsai model, and handles open-ended reasoning Tessera doesn't attempt. **Claude
Projects** and **NotebookLM** in particular do grounded, cited Q&A over uploaded documents very
well. If your data is *not* sensitive and you want the best possible draft from a chat box,
they're hard to beat — and they require zero install. Tessera's bet is only worth it when the
data can't go to their cloud.

**Notion and Coda win on collaboration and ecosystem.** They are excellent real-time, multi-user
workspaces with deep integration ecosystems, mobile apps, and years of polish. If your core need
is many people editing the same docs and databases live, with AI as a helper, that's their home
turf and Tessera is not trying to replace it. Tessera has no live co-editing; KChat (Mattermost
v4) covers async team comms, not collaborative cursors in a document.

**Mature local RAG tools win on flexibility and model choice.** AnythingLLM, LM Studio, Jan, and
GPT4All let a technical user swap in many different local (or remote) models, tune context
windows, and wire up their own pipelines. Obsidian + plugins has a massive ecosystem and a
devoted note-taking community. Tessera deliberately trades some of that flexibility for an
opinionated, structured, zero-setup path — which is the right call for a non-technical SME and
the wrong call for a tinkerer who wants full control of the stack.

## Where Tessera wins

**It's usable on the data the others can't touch.** PHI, privileged contracts, borrower NPI,
unpublished financials — the work in posts 1–5 is precisely the work a cloud assistant is
blocked from by policy. Local-first isn't a privacy *nicety* here; it's the precondition for
using an AI tool at all. The index is local, the model is local, and nothing leaves the machine
without an explicit, visible export.

**Structure and provenance are built in, not bolted on.** A cloud assistant gives you a
transcript; Notion AI gives you a paragraph in a doc. Tessera gives you a *deliverable* —
a 12-section HIPAA report, a credit memo, a QBR deck — whose structure is enforced by a template
(you can't accidentally skip the four-factor analysis) and whose every section **cites the
source file it drew from**. For regulated work, "where did this number come from?" is the whole
job, and Tessera answers it by construction.

**Verifiable, post-quantum-ready provenance on export.** The Evidence Pack bundles the artifact,
its cited sources, and an ML-DSA-65 (FIPS 204) signature. No mainstream cloud workspace ships
verifiable, tamper-evident export provenance; Tessera does, on-device.

**No per-seat, no per-token, fully inspectable.** It's MIT-licensed and runs a local model, so
there's no metered cost and no closed black box — you can read exactly how indexing, retrieval,
and generation work.

## Where Tessera loses today — without spin

- **Model quality ceiling.** The on-device model is small by necessity. For pure draft fluency
  on non-sensitive text, a frontier cloud model is better. Tessera's structure + grounding
  narrow the gap for *deliverables*, but they don't erase it for open-ended writing.
- **No real-time collaboration.** No live co-editing or presence. Teams that need that will keep
  a cloud workspace alongside Tessera.
- **Ecosystem breadth.** Connectors v2 (Drive, OneDrive/SharePoint, Notion, Jira, Confluence,
  Figma) is growing but far smaller than the integration catalogs of Notion/Google/Microsoft.
- **No first-party mobile app.** It's a desktop-first Electron + Rust application.

The knowledge-browser UI used to be on this list — the dedicated Memory page, concept-graph
panel, and enriched "Knowledge" citation tab were "built and tested but not yet wired into the
renderer." They now ship (see [post 7](07-knowledge-plane.md)), and CI builds the private
`kennguy3n/knowledge` substrate dependency over a read-only deploy key, so neither is a gap
anymore.

## Who should (and shouldn't) choose Tessera

**Choose Tessera if** you're an individual professional or a small team turning *sensitive*
source material into *structured, defensible* deliverables — compliance, legal, credit,
grants, ops — and "it can't go to the cloud" is a hard constraint. The local-first architecture,
enforced structure, per-claim citations, and signed export are built for exactly that.

**Don't choose Tessera (yet) if** your primary need is real-time multi-user collaboration, the
absolute best open-ended prose quality on non-sensitive data, a large mobile-first integration
ecosystem, or a tinkerer's freedom to swap arbitrary models. Those are real strengths of the
alternatives, and pretending otherwise would undercut the one thing this showcase is for:
showing you the whole picture, including the parts that don't flatter us.

## The one-line position

**The only AI workspace built local-first for the work that can't go to the cloud — where every
artifact cites its sources and every export can be cryptographically verified — and we'll tell
you exactly where it isn't the right tool.**

---

Back to the [series introduction](00-introduction.md) · or the [showcase index](../README.md)
