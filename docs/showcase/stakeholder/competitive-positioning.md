# Tessera — Competitive Positioning

*How Tessera compares to the alternatives a buyer is actually weighing.*

## The category problem

"AI productivity" has become a crowded, undifferentiated category. Buyers are choosing among
three very different things that all claim the same benefit:

1. **Cloud AI assistants** (ChatGPT, Claude, Gemini, Copilot) — a chat box over a hosted model.
2. **Cloud-first workspaces with AI bolted on** (Notion AI, Coda AI, Google Workspace /
   Gemini) — documents and databases that send your content to a vendor cloud for AI.
3. **Tessera** — a local-first workspace where indexing and AI generation happen on your
   machine, and every artifact is source-cited.

## The comparison that matters

| Dimension | Cloud AI assistant | Cloud-first workspace + AI | **Tessera** |
|-----------|--------------------|-----------------------------|-------------|
| Where your data lives | Vendor cloud | Vendor cloud | **Your device** |
| Where inference runs | Vendor cloud | Vendor cloud | **Your device** |
| Usable with PHI / privileged / NPI data | Rarely (policy blocks) | Rarely (policy blocks) | **Yes — that's the point** |
| Output format | Chat text | Docs/DB, but AI is an add-on | **Document / slides / sheet / base, first-class** |
| Editor depth | None | Strong | **Parity-level: Docs blocks + comments + AI assist, Sheets 160+ formulas + conditional formatting + charts + pivots, Airtable-style multi-table bases, Slides layouts/themes/presenter mode** |
| Source grounding | You paste context in | Limited, workspace-scoped | **You select sources; output cites them** |
| Provenance / citations | None by default | Limited | **Inline per-section citations** |
| Structure enforcement | None (freeform) | Some | **Template sections enforce completeness** |
| Integrations | N/A | Large | **33 read-only, least-privilege connectors** |
| Cost model | Per-seat subscription + usage | Per-seat subscription | **Open source, local model (no per-token cost)** |
| Auditability | Closed | Closed | **MIT-licensed, inspectable** |

## Against cloud AI assistants

A chat assistant is a great brainstorming partner and a poor compliance tool. It produces
freeform prose with no inherent structure, no citations, and no guarantee it didn't invent a
figure. Crucially, for regulated data it's usually **off-limits by policy** — you cannot paste
PHI or a privileged contract into a hosted model. Tessera is designed for exactly the work a
cloud assistant can't legally touch, and it returns a structured, editable artifact rather
than a transcript.

## Against cloud-first workspaces with AI

Notion, Coda, and Google Workspace are excellent collaborative workspaces, but their AI is an
add-on to a cloud-first data model: your content lives on their servers and is sent to their
models. For teams whose data can't leave their control, that architecture is disqualifying no
matter how good the features are. Tessera flips the default — local-first, with cloud sources
as an explicit opt-in — and makes source-citation a built-in property of every artifact rather
than a feature you have to wire up.

## Against "just run a local LLM yourself"

A technical user can run a local model and prompt it by hand. Tessera turns that into a
product: 173 ready templates that enforce the structure of real deliverables, automatic
source indexing and selection, inline citations, four parity-level editors (a Notion-style
document editor, a Sheets-class spreadsheet with 160+ formula functions, conditional
formatting, charts, and pivot tables, an Airtable-style multi-table base, and a Slides-class
deck builder with a presenter mode), 33 read-only connectors, and exports to the formats teams
actually use — plus zero-setup
onboarding for non-technical users. The local model is the engine; the workspace is the value.

## Where Tessera is *not* the answer

Honesty builds trust, so: Tessera is **not** a real-time messaging or collaboration tool, not
a chatbot, and not a cloud-first system of record for a whole company's collaborative editing.
If your primary need is many people editing the same doc live in the browser, a cloud
workspace is a better fit. Tessera's sweet spot is an individual professional or team turning
sensitive source material into defensible, structured deliverables — locally.

## The one-line position

**The only AI workspace built local-first for the work that can't go to the cloud — and the
only one where every artifact cites its sources.**
