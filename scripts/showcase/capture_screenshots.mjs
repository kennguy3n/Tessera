// Deterministic marketing-screenshot capture for the showcase docs.
//
// Drives the QA renderer bundle (npm run build:qa -> preview:qa on :5180)
// through the showcase bridge (?showcase=<persona>) with a fixed clock, then
// captures clean app-viewport PNGs into docs/showcase/assets/screenshots/.
// No real Chrome chrome / desktop taskbar — uniform, current-state evidence.
//
// Usage:  node scripts/showcase/capture_screenshots.mjs [filter]
//   filter (optional): only capture shots whose output name includes it.

import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = process.env.SHOWCASE_BASE ?? "http://localhost:5180";
const FIXED_CLOCK = new Date("2026-05-12T15:04:00.000Z");
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/showcase/assets/screenshots",
);
const FILTER = process.argv[2] ?? "";
const VIEWPORT = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bridgeReady(page) {
  await page.waitForFunction(() => !!window.tessera, undefined, { timeout: 20000 });
}
async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await sleep(600);
}
function q(persona, theme) {
  return `showcase=${persona}${theme ? `&theme=${theme}` : ""}`;
}
async function gotoRoute(page, persona, route, theme) {
  await page.clock.setFixedTime(FIXED_CLOCK);
  await page.goto(`${BASE}${route}?${q(persona, theme)}`);
  await bridgeReady(page);
  await page.locator("h1, [role='dialog']").first().waitFor({ state: "visible", timeout: 15000 });
  await settle(page);
}
async function openEditor(page, persona, artifactType, theme) {
  await page.clock.setFixedTime(FIXED_CLOCK);
  await page.goto(`${BASE}/?${q(persona, theme)}`);
  await bridgeReady(page);
  const id = await page.evaluate(async (wanted) => {
    const list = (await window.tessera.artifacts.list()) ?? [];
    return list.find((a) => a.artifactType === wanted)?.id ?? null;
  }, artifactType);
  if (!id) throw new Error(`no ${artifactType} artifact for ${persona}`);
  await page.goto(`${BASE}/artifacts/${id}/edit?${q(persona, theme)}`);
  await bridgeReady(page);
  await page.locator('nav[aria-label="Breadcrumb"]').first().waitFor({ state: "visible", timeout: 15000 });
  await page.getByText("Loading editor", { exact: false }).first().waitFor({ state: "detached", timeout: 25000 }).catch(() => {});
  await settle(page);
  return id;
}
async function shot(page, name, opts = {}) {
  await page.screenshot({ path: path.join(OUT, name), fullPage: !!opts.fullPage });
  console.log("captured", name);
}
async function scrollToHeading(page, text) {
  const h = page.getByRole("heading", { name: text, exact: false }).first();
  await h.scrollIntoViewIfNeeded();
  await h.evaluate((el) => window.scrollBy(0, -24));
  await sleep(400);
}

const JOBS = [
  // ---- Persona editors (light) ----
  { name: "healthcare-document-hipaa.png", run: async (p) => { await openEditor(p, "healthcare", "document"); await shot(p, "healthcare-document-hipaa.png"); } },
  { name: "healthcare-base-tracker.png", run: async (p) => { await openEditor(p, "healthcare", "base"); await shot(p, "healthcare-base-tracker.png"); } },
  { name: "healthcare-base-expand.png", run: async (p) => {
      await openEditor(p, "healthcare", "base");
      await p.getByRole("button", { name: "Expand record" }).first().click();
      await p.getByRole("dialog").waitFor({ state: "visible", timeout: 8000 });
      await sleep(600);
      await shot(p, "healthcare-base-expand.png");
    } },
  { name: "legal-document-contract.png", run: async (p) => { await openEditor(p, "legal", "document"); await shot(p, "legal-document-contract.png"); } },
  { name: "legal-sheet-obligations.png", run: async (p) => { await openEditor(p, "legal", "sheet"); await shot(p, "legal-sheet-obligations.png"); } },
  { name: "finance-document-credit-memo.png", run: async (p) => { await openEditor(p, "finance", "document"); await shot(p, "finance-document-credit-memo.png"); } },
  { name: "finance-sheet-projection.png", run: async (p) => { await openEditor(p, "finance", "sheet"); await shot(p, "finance-sheet-projection.png"); } },
  { name: "nonprofit-document-grant.png", run: async (p) => { await openEditor(p, "nonprofit", "document"); await shot(p, "nonprofit-document-grant.png"); } },
  { name: "nonprofit-slides-board.png", run: async (p) => { await openEditor(p, "nonprofit", "slides"); await shot(p, "nonprofit-slides-board.png"); } },
  { name: "retail-base-crm.png", run: async (p) => { await openEditor(p, "retail", "base"); await shot(p, "retail-base-crm.png"); } },
  { name: "retail-slides-qbr.png", run: async (p) => { await openEditor(p, "retail", "slides"); await shot(p, "retail-slides-qbr.png"); } },

  // ---- Flow / app-shell (light) ----
  { name: "flow-01-home.png", run: async (p) => { await gotoRoute(p, "healthcare", "/"); await shot(p, "flow-01-home.png"); } },
  { name: "flow-02-create-intent.png", run: async (p) => { await gotoRoute(p, "healthcare", "/create"); await shot(p, "flow-02-create-intent.png"); } },
  { name: "flow-03-create-templates.png", run: async (p) => {
      await gotoRoute(p, "healthcare", "/create");
      await p.getByText("Write a document", { exact: false }).first().click();
      await sleep(500);
      await shot(p, "flow-03-create-templates.png");
    } },
  { name: "flow-04-sources.png", run: async (p) => { await gotoRoute(p, "healthcare", "/sources"); await shot(p, "flow-04-sources.png"); } },
  { name: "flow-05-settings-search.png", run: async (p) => { await gotoRoute(p, "healthcare", "/settings"); await scrollToHeading(p, "Search"); await shot(p, "flow-05-settings-search.png"); } },
  { name: "flow-06-settings-backup.png", run: async (p) => { await gotoRoute(p, "healthcare", "/settings"); await scrollToHeading(p, "Backup & Recovery"); await shot(p, "flow-06-settings-backup.png"); } },
  { name: "flow-07-memory-page.png", run: async (p) => { await gotoRoute(p, "healthcare", "/memory"); await shot(p, "flow-07-memory-page.png"); } },
  { name: "flow-07b-memory-decay.png", run: async (p) => { await gotoRoute(p, "healthcare", "/memory"); await p.getByRole("button", { name: /Fading/ }).click().catch(() => {}); await sleep(400); await shot(p, "flow-07b-memory-decay.png"); } },
  { name: "flow-08-concept-graph.png", run: async (p) => { await gotoRoute(p, "healthcare", "/memory"); await scrollToHeading(p, "Concept graph"); await sleep(600); await shot(p, "flow-08-concept-graph.png"); } },
  { name: "flow-09-knowledge-tab.png", run: async (p) => {
      await openEditor(p, "healthcare", "document");
      await p.getByRole("button", { name: "Citations" }).first().click();
      await sleep(400);
      await p.getByRole("button", { name: "Add a new citation" }).first().click();
      await p.getByPlaceholder("Search sources...").first().waitFor({ state: "visible", timeout: 8000 });
      await p.getByPlaceholder("Search sources...").first().fill("encryption");
      await p.getByRole("button", { name: "Search", exact: true }).first().click();
      await sleep(900);
      await p.getByRole("button", { name: /Knowledge \(/ }).first().click().catch(async () => { await p.getByText(/Knowledge \(/).first().click(); });
      await sleep(600);
      await p.getByText("Add Citation from Sources", { exact: false }).first().scrollIntoViewIfNeeded();
      await shot(p, "flow-09-knowledge-tab.png", { fullPage: true });
    } },
  { name: "flow-10-connector-gallery.png", run: async (p) => {
      await gotoRoute(p, "healthcare", "/sources");
      const gallery = p.getByPlaceholder(/Search connectors/i).first();
      await gallery.scrollIntoViewIfNeeded();
      await sleep(400);
      await shot(p, "flow-10-connector-gallery.png", { fullPage: true });
    } },

  // ---- Multi-pane workspace ----
  { name: "workspace-split-panes.png", run: async (p) => {
      await openEditor(p, "retail", "base");
      await p.evaluate(() => window.dispatchEvent(new CustomEvent("tessera:split-right")));
      await sleep(1500);
      await p.keyboard.press("Control+p");
      await p.getByRole("dialog").waitFor({ state: "visible", timeout: 8000 });
      await sleep(500);
      await p.keyboard.press("Enter");
      await p.getByText("Loading editor", { exact: false }).first().waitFor({ state: "detached", timeout: 20000 }).catch(() => {});
      await settle(p);
      await shot(p, "workspace-split-panes.png");
    } },

  // ---- Dark variants ----
  { name: "memory-page-dark.png", run: async (p) => { await gotoRoute(p, "healthcare", "/memory", "dark"); await shot(p, "memory-page-dark.png"); } },
  { name: "concept-graph-dark.png", run: async (p) => { await gotoRoute(p, "healthcare", "/memory", "dark"); await scrollToHeading(p, "Concept graph"); await sleep(600); await shot(p, "concept-graph-dark.png"); } },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
await page.emulateMedia({ reducedMotion: "reduce" });

let ok = 0, fail = 0;
for (const job of JOBS) {
  if (FILTER && !job.name.includes(FILTER)) continue;
  try {
    await job.run(page);
    ok++;
  } catch (e) {
    fail++;
    console.error("FAILED", job.name, "->", e.message);
  }
}
await browser.close();
console.log(`\nDONE ok=${ok} fail=${fail}`);
