#!/usr/bin/env node
/*
 * Interaction / render performance budgets.
 *
 * The cold-start gate (scripts/coldStartGate.cjs) covers boot-to-first-render
 * of the Electron shell. This sibling gate covers the *heavy in-app surfaces*
 * the user opens after boot — the four artifact editors and the concept-graph
 * Canvas path at scale — and fails when any of them regress past its budget.
 *
 * How it measures (deterministic, no sleeps-as-synchronisation):
 *   - Serves the showcase-enabled production bundle
 *     (`npm run build:qa` -> renderer-dist-qa/) via `vite preview`. The bundle
 *     is seeded with deterministic persona data and honours `?theme=` /
 *     `?graphScale=` query params, so every run drives identical work.
 *   - For each surface, opens a *fresh* page and reads the in-page
 *     `performance.now()` at the moment the surface's "ready" DOM signal is
 *     true (plus two rAFs so the first paint has committed). Because that
 *     clock's origin is the document's navigation start, the number is the
 *     bundle-parse + mount + first-render cost of that surface, measured
 *     inside the page — independent of Playwright IPC latency or wall-clock
 *     spawn overhead.
 *   - Reports the MEDIAN over N samples after discarding `warmup` runs, so a
 *     single GC pause or a cold HTTP-cache first paint can't trip the gate.
 *
 * Budgets live in apps/desktop/qa/perf-budgets.json (single source of truth,
 * shared with the cold-start gate). Exit non-zero with a per-surface report
 * listing which budget blew and by how much.
 *
 * Exit codes (mirroring coldStartGate.cjs):
 *   0 — every surface's median <= its budget.
 *   1 — at least one surface regressed past budget.
 *   2 — harness error (bundle missing, server didn't come up, a surface
 *       never reached its ready signal). Distinct from a perf regression so
 *       CI logs disambiguate "too slow" from "didn't render".
 *
 * Environment overrides:
 *   TESSERA_PERF_PORT      preview server port (default 5180).
 *   TESSERA_PERF_SAMPLES   override sample count from the config.
 *   TESSERA_PERF_KEEP_SERVER=1  measure against an already-running
 *                          preview:qa instead of spawning one (faster local
 *                          iteration).
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "@playwright/test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = path.join(REPO_ROOT, "apps", "desktop");
const CONFIG_PATH = path.join(DESKTOP_DIR, "qa", "perf-budgets.json");
const PORT = Number(process.env.TESSERA_PERF_PORT || 5180);
// 127.0.0.1, not "localhost": vite preview binds IPv4 by default, but
// Node's fetch resolves "localhost" to IPv6 (::1) first on many systems
// (notably the CI container), so a "localhost" probe would hang until the
// startup timeout even though the server is up.
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;

function die(code, msg) {
  console.error(`[perf-budgets] ${msg}`);
  process.exit(code);
}

// ---- config -------------------------------------------------------------
let CONFIG;
try {
  CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (err) {
  die(2, `could not read budget config at ${CONFIG_PATH}: ${err.message}`);
}
const SAMPLES = Math.max(
  1,
  Number(process.env.TESSERA_PERF_SAMPLES || CONFIG.samples || 5),
);
const WARMUP = Math.max(0, Number(CONFIG.warmup ?? 1));
const GRAPH_SCALE = Math.max(1, Number(CONFIG.graphScale || 300));
const BUDGETS = CONFIG.interaction || {};

// The bundle must exist; bail with an actionable message rather than a
// confusing server/blank-page failure.
if (!existsSync(path.join(DESKTOP_DIR, "renderer-dist-qa", "index.html"))) {
  die(
    2,
    "renderer-dist-qa/index.html not found. Run `npm run build:qa` (in apps/desktop) before the perf gate.",
  );
}

/**
 * Surfaces to budget. `ready` is the DOM signal whose presence (>= `min`
 * matches) means the surface has rendered. Editors are reached by resolving
 * the first showcase artifact of `artifactType` over the mock bridge; the
 * graph is a route driven onto the Canvas path with `?graphScale=`.
 */
const SURFACES = [
  {
    key: "editor-document",
    persona: "finance",
    artifactType: "document",
    ready: ".document-editor-content .ProseMirror",
    min: 1,
  },
  {
    key: "editor-sheet",
    persona: "finance",
    artifactType: "sheet",
    ready: "[class*=sheet] [role=gridcell], .sheet-formula-bar",
    min: 1,
  },
  {
    key: "editor-base",
    persona: "retail",
    artifactType: "base",
    ready: ".base-cell-input",
    min: 10,
  },
  {
    key: "editor-slides",
    persona: "retail",
    artifactType: "slides",
    ready: "[class*=slide]",
    min: 5,
  },
  {
    key: "graph-canvas",
    persona: "finance",
    route: `/memory`,
    extraQuery: { graphScale: String(GRAPH_SCALE) },
    ready: "[data-testid=concept-graph-canvas]",
    min: 1,
  },
];

function queryFor(persona, extra) {
  const params = new URLSearchParams({ showcase: persona, theme: "light" });
  for (const [k, v] of Object.entries(extra || {})) params.set(k, v);
  return params.toString();
}

// ---- server lifecycle ---------------------------------------------------
async function waitForServer(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`preview server did not respond at ${BASE} within ${timeoutMs}ms`);
}

let serverProc = null;
async function startServer() {
  if (process.env.TESSERA_PERF_KEEP_SERVER) {
    await waitForServer();
    return;
  }
  // `-- --host 127.0.0.1`: pin vite preview to IPv4 so the `HOST` probe
  // below reaches it. By default vite binds "localhost", which in the CI
  // container resolves to IPv6 (::1) only, leaving an IPv4 probe refused.
  serverProc = spawn(
    "npm",
    ["run", "preview:qa", "--", "--host", HOST, "--port", String(PORT)],
    {
      cwd: DESKTOP_DIR,
      env: { ...process.env, TESSERA_QA_PORT: String(PORT) },
      stdio: "ignore",
      // Run the launcher in its own process group so stopServer() can signal
      // the whole tree (npm -> sh -> vite), not just the npm launcher — see
      // stopServer() for why signalling npm alone orphans vite.
      detached: true,
    },
  );
  serverProc.on("error", (err) =>
    die(2, `failed to spawn preview server: ${err.message}`),
  );
  await waitForServer();
}
let serverStopped = false;
function stopServer() {
  if (!serverProc || serverStopped) return;
  serverStopped = true;
  const pid = serverProc.pid;
  if (!pid) return;
  // `npm run preview:qa` spawns a tree: npm -> sh -> vite, and the npm
  // launcher exits as soon as it has handed off, so `vite` is reparented to
  // init while still holding PORT. We must therefore signal the *process
  // group*, not `serverProc` (npm) — which has usually already exited by the
  // time we get here (so we deliberately do NOT gate on `serverProc.exitCode`:
  // the group outlives its leader). `detached: true` gave the tree its own
  // group whose id equals the npm pid, so the negative-pid signal reaches the
  // surviving sh + vite; SIGTERM lets vite close its listener and free the
  // port before the next `--strictPort` run.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // No group to signal (truly gone, or a platform without POSIX
    // process-group semantics): fall back to the direct child.
    try {
      serverProc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// Reap the spawned `vite preview` child if this process is interrupted
// (local Ctrl+C, or a SIGTERM/SIGHUP from a runner) rather than exiting
// through `main()`'s normal path. Without this the preview server would be
// left holding `PORT`, and the next run — which uses `--strictPort` — would
// fail to bind. Re-raise as the conventional 128+signo exit code (SIGINT=130,
// SIGTERM=143, SIGHUP=129) so a parent/runner can still tell which signal
// interrupted us; derived from the signal number rather than hard-coded so it
// stays correct per-signal.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    stopServer();
    process.exit(128 + (osConstants.signals[sig] ?? 0));
  });
}

// ---- measurement --------------------------------------------------------
/** Read in-page time-origin -> ready-signal-painted, in ms. */
async function measureOnce(ctx, url, ready, min) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "commit" });
    const ms = await page.evaluate(
      async ({ ready, min }) => {
        const ok = () => document.querySelectorAll(ready).length >= min;
        const start = performance.now();
        let waited = 0;
        while (!ok() && waited < 15_000) {
          await new Promise((r) => requestAnimationFrame(r));
          waited = performance.now() - start;
        }
        if (!ok()) return null;
        // Two rAFs: ensure the frame that contains the ready node has
        // actually been painted before we stop the clock.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return performance.now();
      },
      { ready, min },
    );
    return ms;
  } finally {
    await page.close();
  }
}

async function resolveArtifactId(ctx, persona, artifactType) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/?${queryFor(persona)}`);
    await page.waitForFunction(() => !!window.tessera, null, { timeout: 15_000 });
    const id = await page.evaluate(async (wanted) => {
      const list = (await window.tessera?.artifacts?.list?.()) ?? [];
      return list.find((a) => a.artifactType === wanted)?.id ?? null;
    }, artifactType);
    if (!id) throw new Error(`no showcase artifact of type "${artifactType}"`);
    return id;
  } finally {
    await page.close();
  }
}

async function urlForSurface(ctx, s) {
  const query = queryFor(s.persona, s.extraQuery);
  if (s.route) return `${BASE}${s.route}?${query}`;
  const id = await resolveArtifactId(ctx, s.persona, s.artifactType);
  return `${BASE}/artifacts/${id}/edit?${query}`;
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
  console.log(
    `[perf-budgets] samples=${SAMPLES} warmup=${WARMUP} graphScale=${GRAPH_SCALE} port=${PORT}`,
  );
  await startServer();

  const browser = await chromium.launch({
    args: ["--force-color-profile=srgb", "--disable-gpu", "--no-sandbox"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const results = [];
  try {
    for (const s of SURFACES) {
      const budget = Number(BUDGETS[s.key]);
      if (!Number.isFinite(budget)) {
        throw new Error(`no budget for surface "${s.key}" in ${CONFIG_PATH}`);
      }
      const url = await urlForSurface(ctx, s);
      const samples = [];
      for (let i = 0; i < SAMPLES + WARMUP; i++) {
        const ms = await measureOnce(ctx, url, s.ready, s.min);
        if (ms === null) {
          throw new Error(
            `surface "${s.key}" never reached ready signal "${s.ready}" (>= ${s.min})`,
          );
        }
        if (i >= WARMUP) samples.push(ms);
      }
      const med = median(samples);
      const pass = med <= budget;
      results.push({ key: s.key, med, budget, pass, samples });
      console.log(
        `[perf-budgets] ${pass ? "PASS" : "FAIL"} ${s.key}: median ${med.toFixed(0)}ms ` +
          `(budget ${budget}ms) [${samples.map((n) => n.toFixed(0)).join(", ")}]`,
      );
    }
  } catch (err) {
    stopServer();
    await browser.close();
    die(2, `harness error: ${err.message}`);
  }

  await browser.close();
  stopServer();

  const failed = results.filter((r) => !r.pass);
  console.log("\n[perf-budgets] summary:");
  for (const r of results) {
    const delta = r.med - r.budget;
    console.log(
      `  ${r.pass ? "ok  " : "FAIL"} ${r.key.padEnd(16)} ${r.med
        .toFixed(0)
        .padStart(5)}ms / ${String(r.budget).padStart(5)}ms` +
        (r.pass ? "" : `  (+${delta.toFixed(0)}ms over budget)`),
    );
  }
  if (failed.length) {
    console.error(
      `\n[perf-budgets] FAIL: ${failed.length} surface(s) over budget: ` +
        failed.map((r) => `${r.key} (+${(r.med - r.budget).toFixed(0)}ms)`).join(", "),
    );
    process.exit(1);
  }
  console.log(`\n[perf-budgets] PASS: all ${results.length} surfaces within budget.`);
  process.exit(0);
}

main().catch((err) => {
  stopServer();
  die(2, `unexpected harness error: ${err && err.stack ? err.stack : err}`);
});
