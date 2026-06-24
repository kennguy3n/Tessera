# Tessera — Getting Started

_From install to your first source-cited artifact._

This guide mirrors the flow shown in the [UI/UX walkthrough](../blog/06-ui-ux-walkthrough.md)
and gets a new user productive quickly.

## 1. Install and first launch

Install the Tessera desktop app for your platform. On first launch:

- Tessera detects your hardware and, if you're online and haven't opted out, **automatically
  downloads the recommended local AI model in the background.** This is non-blocking — a slim
  progress banner shows "Setting up AI capabilities…" while you start working. You can begin
  immediately in source-based mode and AI-powered generation switches on as soon as the model
  is ready.
- If you'd rather not auto-download, you can disable **Settings → "Auto-download recommended AI
  model"** and manage models manually.

## 2. Add your first source

Open **Sources** and point Tessera at a folder of real material — the files you'd normally
copy from when writing a deliverable. Tessera indexes it **locally**. Optionally connect a
cloud source (Google Drive, OneDrive/SharePoint, Notion, Jira, Confluence, Figma); connections
are explicit and show a connected/disconnected state.

> Tip: start with the source material for one specific deliverable you make often. Narrow and
> real beats broad and generic.

## 3. Create your first artifact

Open **Create**. You'll be asked **"What do you need?"** with four choices:

- **Write a document** — reports, summaries, proposals, SOPs, memos.
- **Make a presentation** — QBRs, strategy decks, pitches.
- **Track data in a spreadsheet** — budgets, trackers, scorecards, projections.
- **Build a database** — CRMs, risk registers, inventories, trackers.

Pick one, then choose from the curated shortlist of templates for that type. (Need something
specific? "Show all templates" reveals the full library of 173.)

## 4. Select sources and generate

Choose which indexed folders / connected sources this artifact may draw from, then generate.
Tessera runs each of the template's section prompts against **only** the sources you selected.

- With a model installed, you get **AI-enhanced** generation — drafted prose, tables, and
  structure.
- Before the model finishes downloading, you get **source-based** generation — your material
  assembled into the template structure. The button label and a badge make the current mode
  clear.

## 5. Review, edit, and verify provenance

Your artifact opens in the editor for its type:

- **Documents** — rich text with a live outline panel and formatting toolbar.
- **Sheets** — a typed grid with import/export and conditional formatting.
- **Bases** — typed fields (including select dropdowns) with Grid, Kanban, Calendar, Timeline,
  Gallery, and Form views.
- **Slides** — a deck editor with slide navigator, content blocks, speaker notes, presenter
  mode, and raw Marp mode.

Look for the inline source markers (e.g. `[01-quarterly-sales-data.md]`) — each shows which
source file a section drew from. Edit anything; it's a real artifact, not a locked AI output.

## 6. Export

Export to the format you need: **Markdown / HTML / PDF / DOCX** for documents, **CSV / XLSX**
for sheets and bases, **PPTX** for slides.

## Tips for non-technical users

- **Trust the shortlist.** The curated templates cover the most common needs; you don't have
  to browse all 173.
- **Smaller sources, better drafts.** Select the sources actually relevant to this artifact
  rather than everything you've indexed.
- **The draft is a starting point.** Generation gets you to a structured, cited first draft
  fast; your edits make it final.
- **Customize the defaults later.** Once comfortable, Settings lets power users expand the full
  sidebar ("More tools") and default Create to the full gallery.

## Where to go next

- See the flow applied to real work in the [persona series](../blog/00-introduction.md).
- Review data handling in the [Security & Privacy Brief](security-and-privacy-brief.md).
- Plan a rollout with the [Buyer's Guide & ROI](buyers-guide-and-roi.md).
