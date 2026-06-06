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
 * Environment overrides:
 *   TESSERA_COLD_START_BUDGET_MS  budget in ms (default 3000).
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

const BUDGET_MS = Number(process.env.TESSERA_COLD_START_BUDGET_MS || 3000);
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
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-coldstart-"));

console.log(
  `[cold-start-gate] budget=${BUDGET_MS}ms timeout=${TIMEOUT_MS}ms userData=${userDataDir}`,
);

const child = spawn(
  electron,
  [
    ".",
    // Chromium can't sandbox under the unprivileged CI user without a
    // setuid helper; --no-sandbox is the standard headless-CI flag.
    "--no-sandbox",
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

let stdout = "";
let stderr = "";
let settled = false;

const timer = setTimeout(() => {
  finish(null, `timed out after ${TIMEOUT_MS}ms waiting for the first frame.`);
}, TIMEOUT_MS);
timer.unref();

function cleanup() {
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
}

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
 * Single settle point. `measured` is the parsed cold-start ms (or
 * null if we never got a usable marker); `harnessError` is set when
 * the run failed for a non-perf reason (timeout / spawn error / no
 * marker). Called at most once.
 */
function finish(measured, harnessError) {
  if (settled) return;
  settled = true;
  cleanup();

  if (measured === null) {
    console.error("----- electron stdout -----");
    console.error(stdout.trim() || "(empty)");
    console.error("----- electron stderr -----");
    console.error(stderr.trim() || "(empty)");
    fail(2, harnessError || `no ${MARKER}<n> marker on stdout.`);
  }

  const verdict = measured <= BUDGET_MS ? "PASS" : "FAIL";
  console.log(
    `[cold-start-gate] ${verdict}: boot-to-first-render ${measured.toFixed(2)}ms (budget ${BUDGET_MS}ms)`,
  );
  process.exit(measured <= BUDGET_MS ? 0 : 1);
}

// Decide as soon as the marker streams in rather than waiting for the
// process to exit. The probe force-exits itself after emitting, but a
// headless Electron can be slow (or fail) to tear down its GPU/helper
// processes; keying off stdout makes the gate independent of how
// cleanly the child exits.
child.stdout.on("data", (d) => {
  stdout += d.toString();
  const measured = parseMeasuredMs(stdout);
  if (measured !== null) finish(measured, null);
});
child.stderr.on("data", (d) => {
  stderr += d.toString();
});

child.on("error", (err) => {
  finish(null, `failed to spawn electron: ${err.message}`);
});

// If the process exits before any marker arrived, that's a harness
// failure (crash / missing bundle). A marker seen on stdout already
// settled us above, so this only fires on the no-marker path.
child.on("exit", (code, signal) => {
  finish(
    parseMeasuredMs(stdout),
    `electron exited (code=${code} signal=${signal}) before emitting ${MARKER}<n>.`,
  );
});
