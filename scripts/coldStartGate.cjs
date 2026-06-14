#!/usr/bin/env node
/*
 * Cold-start performance gate.
 *
 * Boots the *built* Electron app once in headless "perf smoke" mode
 * (TESSERA_PERF_SMOKE=1), reads the boot-to-first-render duration the
 * main process emits on `ready-to-show`, and fails if it exceeds the
 * budget. Wired into `.github/workflows/ci.yml` as the cold-start gate
 * and exposed as `npm run perf:cold-start` from the repo root.
 *
 * Measurement source of truth: the main process prints a single
 * `TESSERA_COLD_START_MS=<n>` line once the first frame is shown (see
 * `apps/desktop/electron/main.ts` → `coldStartTotalMs()` from
 * `startupPerf.ts`). This script does NOT time the subprocess wall
 * clock — that would fold in Electron/V8 spawn overhead and xvfb
 * warm-up, inflating the number and making the gate flaky. We assert
 * only on the in-process `performance.measure`-derived total, which is
 * exactly the boot-to-first-render window the instrumentation tracks.
 *
 * Exit codes:
 *   0 — measured cold-start <= budget.
 *   1 — measured cold-start > budget.
 *   2 — harness error (build missing, no marker line, boot timeout,
 *       electron crash). Distinct from a genuine perf regression so
 *       CI logs disambiguate "too slow" from "didn't boot".
 *
 * Budget source of truth: `apps/desktop/qa/perf-budgets.json` →
 * `coldStartMs` (shared with the interaction/render gate
 * `scripts/perfBudgets.mjs`). Was tightened 3000 -> 2000 in LW-8 once the
 * heavy bridge init (open_store + tombstone replay + FTS purge) moved OFF
 * the boot critical path: the gate now measures boot-to-skeleton-paint,
 * not boot-to-store-open.
 *
 * Environment overrides:
 *   TESSERA_COLD_START_BUDGET_MS  budget in ms; overrides the config value
 *                                 for a one-off local run.
 *   TESSERA_COLD_START_TIMEOUT_MS hard boot timeout in ms (default
 *                                 60000) before declaring a harness
 *                                 failure.
 */
"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DESKTOP_DIR = path.join(REPO_ROOT, "apps", "desktop");

// Single source of truth for every perf budget (shared with the
// interaction/render gate in scripts/perfBudgets.mjs). The env override
// still wins so a one-off local run can probe a tighter/looser ceiling
// without editing the committed config.
function coldStartBudgetFromConfig() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(
        path.join(DESKTOP_DIR, "qa", "perf-budgets.json"),
        "utf8",
      ),
    );
    const n = Number(cfg.coldStartMs);
    return Number.isFinite(n) && n > 0 ? n : 2000;
  } catch {
    return 2000;
  }
}

const BUDGET_MS = Number(
  process.env.TESSERA_COLD_START_BUDGET_MS || coldStartBudgetFromConfig(),
);
const TIMEOUT_MS = Number(process.env.TESSERA_COLD_START_TIMEOUT_MS || 60000);
const MARKER = "TESSERA_COLD_START_MS=";

function fail(code, msg) {
  console.error(`[cold-start-gate] ${msg}`);
  process.exit(code);
}

// The gate runs against `npm run build` output. Bail early with an
// actionable message (rather than a confusing electron boot crash) if
// either bundle is missing.
const mainJs = path.join(DESKTOP_DIR, "dist-electron", "electron", "main.js");
const rendererHtml = path.join(DESKTOP_DIR, "renderer-dist", "index.html");
for (const [label, p] of [
  ["electron main bundle", mainJs],
  ["renderer bundle", rendererHtml],
]) {
  if (!fs.existsSync(p)) {
    fail(
      2,
      `${label} not found at ${p}. Run \`npm run build\` before the cold-start gate.`,
    );
  }
}

// Headless: Electron needs an X server. If there's no DISPLAY and
// `xvfb-run` is available, re-exec this script under it exactly once
// (guarded by TESSERA_COLD_START_XVFB so we never recurse forever).
if (!process.env.DISPLAY && !process.env.TESSERA_COLD_START_XVFB) {
  const xvfb = spawnSync("sh", ["-c", "command -v xvfb-run"], {
    encoding: "utf8",
  });
  if (xvfb.status === 0 && xvfb.stdout.trim()) {
    const res = spawnSync(
      "xvfb-run",
      ["-a", process.execPath, __filename],
      {
        stdio: "inherit",
        env: { ...process.env, TESSERA_COLD_START_XVFB: "1" },
      },
    );
    process.exit(res.status === null ? 2 : res.status);
  }
  // No xvfb and no DISPLAY: let Electron try anyway (it will fail
  // fast), but warn so the CI log explains the likely cause.
  console.warn(
    "[cold-start-gate] no DISPLAY and no xvfb-run found; electron may fail to start.",
  );
}

const electron = require("electron"); // path to the electron binary

// Number of boots to sample. We report the *minimum* (see below), so
// more samples only tighten the floor estimate. Default 3 keeps the
// gate fast (~a few seconds/boot) while smoothing out single-boot CI
// jitter.
const SAMPLES = Math.max(1, Number(process.env.TESSERA_COLD_START_SAMPLES || 3));

function parseMeasuredMs(text) {
  const line = text
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.includes(MARKER));
  if (!line) return null;
  const raw = line.slice(line.indexOf(MARKER) + MARKER.length).trim();
  if (raw === "null") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Boot the built app once and resolve with the parsed
 * boot-to-first-render ms, or `{ error }` if this boot never produced
 * a usable marker (crash / timeout / spawn failure). Each boot gets a
 * throwaway user-data dir so no run warms another's profile cache.
 */
function runOnce(index) {
  return new Promise((resolve) => {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tessera-coldstart-"),
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(
      electron,
      [
        ".",
        // Chromium can't sandbox under the unprivileged CI user
        // without a setuid helper; --no-sandbox is the standard
        // headless-CI flag.
        "--no-sandbox",
        // Headless runners have no GPU. Without these, Chromium spawns
        // a GPU process, fails to initialise it under xvfb's software
        // GL, and falls back — adding seconds of one-off flail to the
        // first paint that has nothing to do with *app* boot. Disabling
        // the GPU path entirely makes the number reflect Tessera's own
        // boot-to-first-render. --disable-dev-shm-usage avoids the tiny
        // default /dev/shm on CI containers causing renderer stalls.
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-dev-shm-usage",
        `--user-data-dir=${userDataDir}`,
      ],
      {
        cwd: DESKTOP_DIR,
        env: {
          ...process.env,
          TESSERA_PERF_SMOKE: "1",
          ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const timer = setTimeout(() => {
      finishRun(null, `timed out after ${TIMEOUT_MS}ms waiting for first frame`);
    }, TIMEOUT_MS);
    timer.unref();

    function finishRun(measured, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      if (measured === null) {
        console.error(
          `[cold-start-gate] boot ${index + 1}/${SAMPLES} failed: ${error}`,
        );
        console.error("----- electron stdout -----");
        console.error(stdout.trim() || "(empty)");
        console.error("----- electron stderr -----");
        console.error(stderr.trim() || "(empty)");
        resolve({ measured: null, error });
        return;
      }
      console.log(
        `[cold-start-gate] boot ${index + 1}/${SAMPLES}: ${measured.toFixed(2)}ms`,
      );
      resolve({ measured, error: null });
    }

    // Decide as soon as the marker streams in rather than waiting for
    // the process to exit. The probe force-exits itself after
    // emitting, but a headless Electron can be slow (or fail) to tear
    // down its helper processes; keying off stdout makes the gate
    // independent of how cleanly the child exits.
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      const measured = parseMeasuredMs(stdout);
      if (measured !== null) finishRun(measured, null);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      finishRun(null, `failed to spawn electron: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      finishRun(
        parseMeasuredMs(stdout),
        `electron exited (code=${code} signal=${signal}) before emitting marker`,
      );
    });
  });
}

async function main() {
  console.log(
    `[cold-start-gate] budget=${BUDGET_MS}ms timeout=${TIMEOUT_MS}ms samples=${SAMPLES}`,
  );

  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const { measured } = await runOnce(i);
    if (measured !== null) samples.push(measured);
  }

  if (samples.length === 0) {
    fail(2, `no boot produced a ${MARKER}<n> marker across ${SAMPLES} attempt(s).`);
  }

  // Assert on the MINIMUM, not the mean: the fastest boot is the
  // cleanest estimate of the app's true boot-to-first-render floor,
  // with CI scheduling jitter (a co-tenant stealing a core mid-boot)
  // stripped out. A real regression — more JS to parse, extra sync
  // work before first paint, a heavier initial render — raises even
  // the best-case boot, so the floor still catches it; transient
  // runner noise no longer flakes a required gate.
  const best = Math.min(...samples);
  const verdict = best <= BUDGET_MS ? "PASS" : "FAIL";
  console.log(
    `[cold-start-gate] ${verdict}: best boot-to-first-render ${best.toFixed(2)}ms ` +
      `over ${samples.length}/${SAMPLES} boot(s) [${samples
        .map((s) => s.toFixed(0))
        .join(", ")}ms] (budget ${BUDGET_MS}ms)`,
  );
  process.exit(best <= BUDGET_MS ? 0 : 1);
}

main().catch((err) => {
  fail(2, `unexpected harness error: ${err && err.stack ? err.stack : err}`);
});
