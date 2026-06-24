# Tessera — Executive One-Pager

## The one sentence

Tessera is a **local-first** desktop workspace that turns the files you already have into
**source-cited** documents, presentations, spreadsheets, and databases — using AI that runs
on your machine, so sensitive data never leaves it.

## The problem

Knowledge workers spend hours reshaping the same source material into the deliverables their
job requires — incident reports, contract abstracts, credit memos, grant proposals, QBRs.
Generic AI assistants can help, but they require shipping your data to a cloud API, they
produce un-cited prose you can't defend, and they hand you a blob of text instead of an
editable, structured artifact. In regulated and detail-heavy work, that's a non-starter.

## The approach

Tessera inverts the usual AI demo. Instead of a prompt box and a black box, it makes the
**process** the product:

1. **Pick what you need** — document, slides, sheet, or base, from a structured template.
2. **Choose your sources** — local folders Tessera has indexed, plus any cloud sources you
   explicitly connect.
3. **Generate** — a local model drafts each template section against _your_ material.
4. **Verify** — every section cites the source file behind it; you edit in a real editor and
   export to the formats you actually use.

## Proof: five personas, five markets

This showcase demonstrates the full flow with genuinely AI-generated artifacts (Tessera's
own on-device **Ternary-Bonsai 4B** model, real template prompts, no hand-editing) across
five professionals:

| Persona                   | Market     | Deliverables                               |
| ------------------------- | ---------- | ------------------------------------------ |
| Clinical Privacy Officer  | Healthcare | HIPAA breach assessment + incident tracker |
| Corporate Paralegal       | Legal      | Contract summary + obligation tracker      |
| Commercial Credit Officer | Finance    | Credit memo + 3-year projection            |
| Development Director      | Nonprofit  | Grant proposal + board deck                |
| Sales-Ops Lead            | Retail     | QBR deck + CRM                             |

Every input, prompt, and output is inspectable in [`docs/showcase`](../README.md).

## Why it wins

- **Privacy is the moat.** Local indexing + local inference means PHI, privileged contracts,
  and borrower financials never leave the device. This is the precondition that lets
  regulated teams use AI at all.
- **Defensibility.** Inline citations and template-enforced structure mean every artifact is
  traceable and complete — not a plausible-sounding draft you have to fact-check from scratch.
- **Real artifacts, not chat.** Output lands in four parity-level editors — a Notion-style
  document editor (callout/toggle/TOC blocks + inline comments + AI writing assistant), a
  Sheets-class spreadsheet (160+ formula functions, named ranges, conditional formatting,
  charts, pivot tables), an Airtable-style multi-table base (linked records + lookup/rollup +
  fillable form view), and a Slides-class deck builder (layouts, themes, presenter mode) — and
  exports to Markdown, PDF, DOCX, CSV, XLSX, and PPTX.
- **Zero-friction onboarding.** A simplified four-item sidebar, an intent-based Create wizard,
  and automatic background model setup get a non-technical user to their first artifact fast.

## Status

- Open-source, MIT-licensed, local-first desktop app (Electron + Rust).
- 173 production templates across all four artifact types.
- Four parity-level on-device editors (Docs/Sheets/Slides/Airtable-class) and a catalog of
  33 read-only, least-privilege connectors.
- Security posture includes FIDO2/WebAuthn app-lock, secure-delete on all deletion paths,
  tightened CSP, and supply-chain CI gates (`cargo vet`, `npm audit`).

## The ask

Read one persona journey end to end — [Maya's HIPAA breach assessment](../blog/01-healthcare-privacy-officer.md)
— and inspect its [inputs, prompts, and outputs](../artifacts/healthcare). That five-minute
review is the fastest way to see what "source-backed, local-first generation" actually means.
