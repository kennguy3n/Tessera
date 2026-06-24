import type { Page } from "@playwright/test";

/**
 * Single source of truth for the surfaces the browser QA gates
 * (visual-regression + the axe contrast pass) drive. Each surface is
 * reachable deterministically against the showcase-enabled QA bundle:
 *
 *   - `route`   — a top-level page, reached by URL.
 *   - `editor`  — one of the four artifact editors, reached by resolving
 *                 the first showcase artifact of a given type over the
 *                 mock bridge and navigating to its `/artifacts/:id/edit`.
 *   - `overlay` — a global overlay (command palette / quick switcher)
 *                 opened via the app's own `tessera:open-*` window events
 *                 (the same events the keyboard shortcuts dispatch), so we
 *                 don't couple the harness to specific key bindings.
 *
 * `persona` selects the seeded showcase dataset. Personas are chosen so
 * every editor type is covered: finance has document + sheet, retail has
 * base + slides.
 */
export type ArtifactType = "document" | "sheet" | "slides" | "base";

export interface QaSurface {
  /** Stable id — used for screenshot filenames and report labels. */
  id: string;
  /** Human-readable surface name for reports. */
  title: string;
  /** Showcase persona whose seeded data backs the surface. */
  persona: string;
  kind: "route" | "editor" | "overlay";
  /** Route path for `route`/`overlay` surfaces (e.g. "/memory"). */
  path?: string;
  /** Artifact type to open for `editor` surfaces. */
  artifactType?: ArtifactType;
  /** `tessera:open-*` event name for `overlay` surfaces. */
  openEvent?: "tessera:open-palette" | "tessera:open-quick-switch";
}

export const SURFACES: readonly QaSurface[] = [
  { id: "home", title: "Home", persona: "finance", kind: "route", path: "/" },
  {
    id: "sources",
    title: "Sources",
    persona: "finance",
    kind: "route",
    path: "/sources",
  },
  {
    id: "templates",
    title: "Templates",
    persona: "finance",
    kind: "route",
    path: "/templates",
  },
  {
    id: "create",
    title: "Create",
    persona: "finance",
    kind: "route",
    path: "/create",
  },
  {
    id: "tasks",
    title: "Tasks",
    persona: "finance",
    kind: "route",
    path: "/tasks",
  },
  {
    id: "automations",
    title: "Automations",
    persona: "finance",
    kind: "route",
    path: "/automations",
  },
  {
    id: "memory",
    title: "Memory (concept graph)",
    persona: "finance",
    kind: "route",
    path: "/memory",
  },
  {
    id: "settings",
    title: "Settings",
    persona: "finance",
    kind: "route",
    path: "/settings",
  },
  {
    id: "editor-document",
    title: "Document editor",
    persona: "finance",
    kind: "editor",
    artifactType: "document",
  },
  {
    id: "editor-sheet",
    title: "Sheet editor",
    persona: "finance",
    kind: "editor",
    artifactType: "sheet",
  },
  {
    id: "editor-slides",
    title: "Slide editor",
    persona: "retail",
    kind: "editor",
    artifactType: "slides",
  },
  {
    id: "editor-base",
    title: "Base editor",
    persona: "retail",
    kind: "editor",
    artifactType: "base",
  },
  {
    id: "command-palette",
    title: "Command palette",
    persona: "finance",
    kind: "overlay",
    path: "/",
    openEvent: "tessera:open-palette",
  },
  {
    id: "quick-switcher",
    title: "Quick switcher",
    persona: "finance",
    kind: "overlay",
    path: "/",
    openEvent: "tessera:open-quick-switch",
  },
] as const;

export interface ThemeVariant {
  /** Suffix appended to screenshot names, e.g. "light", "dark", "dark-amber". */
  id: string;
  theme: "light" | "dark";
  accent?: string;
}

/**
 * Theme matrix: light + dark are the baseline (contrast must hold in
 * both); one non-default accent (dark + amber) guards the accent ramp
 * tokens. Kept small so baselines stay reviewable and fast.
 */
export const THEME_VARIANTS: readonly ThemeVariant[] = [
  { id: "light", theme: "light" },
  { id: "dark", theme: "dark" },
  { id: "dark-amber", theme: "dark", accent: "amber" },
] as const;

function surfaceQuery(surface: QaSurface, variant: ThemeVariant): string {
  const params = new URLSearchParams({
    showcase: surface.persona,
    theme: variant.theme,
  });
  if (variant.accent) params.set("accent", variant.accent);
  return params.toString();
}

/** Minimal artifact shape the mock bridge returns from `artifacts.list()`. */
interface BridgeArtifact {
  id: string;
  artifactType: ArtifactType;
}

async function resolveArtifactId(
  page: Page,
  type: ArtifactType,
): Promise<string> {
  const id = await page.evaluate(async (wanted) => {
    const bridge = (
      window as unknown as {
        tessera?: { artifacts?: { list?: () => Promise<BridgeArtifact[]> } };
      }
    ).tessera;
    const list = (await bridge?.artifacts?.list?.()) ?? [];
    return list.find((a) => a.artifactType === wanted)?.id ?? null;
  }, type);
  if (!id) throw new Error(`No showcase artifact of type "${type}" found`);
  return id;
}

/** Wait until the showcase mock bridge has been installed on `window`. */
async function waitForBridge(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as unknown as { tessera?: unknown }).tessera,
    undefined,
    { timeout: 15_000 },
  );
}

/**
 * Showcase data is seeded at this fixed instant (mirrors `NOW` in
 * `renderer/src/showcase/index.ts`). We pin the page clock to it so any
 * relative-time UI ("2h ago", "last backup …") renders identically every
 * run — otherwise those strings drift with wall-clock and flake snapshots.
 * `setFixedTime` freezes `Date.now()`/`new Date()` but keeps timers and
 * rAF running, so the page still settles normally.
 */
const FIXED_CLOCK = new Date("2026-05-12T15:04:00.000Z");

/**
 * Navigate to `surface` in the given theme and return once it is
 * visually settled (bridge installed, fonts loaded, no spinner). Fully
 * deterministic: no fixed sleeps — every wait is keyed to a real signal.
 */
export async function gotoSurface(
  page: Page,
  surface: QaSurface,
  variant: ThemeVariant,
): Promise<void> {
  await page.clock.setFixedTime(FIXED_CLOCK);
  const query = surfaceQuery(surface, variant);

  if (surface.kind === "editor") {
    if (!surface.artifactType)
      throw new Error(`editor surface ${surface.id} missing artifactType`);
    // First load any route to install the bridge, resolve the artifact
    // id, then deep-link the editor with the same showcase query so the
    // bridge re-installs on the editor page.
    await page.goto(`/?${query}`);
    await waitForBridge(page);
    const id = await resolveArtifactId(page, surface.artifactType);
    await page.goto(`/artifacts/${id}/edit?${query}`);
    await waitForBridge(page);
  } else {
    await page.goto(`${surface.path ?? "/"}?${query}`);
    await waitForBridge(page);
  }

  // The data-theme/accent attributes are applied by `useTheme` after the
  // settings load; assert they match before capturing.
  await page.waitForFunction(
    (expected) => {
      const el = document.documentElement;
      return (
        el.getAttribute("data-theme") === expected.theme &&
        (!expected.accent || el.getAttribute("data-accent") === expected.accent)
      );
    },
    { theme: variant.theme, accent: variant.accent ?? null },
    { timeout: 15_000 },
  );

  if (surface.kind === "overlay" && surface.openEvent) {
    await page.evaluate(
      (evt) => window.dispatchEvent(new Event(evt)),
      surface.openEvent,
    );
    await page
      .locator('[role="dialog"]')
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  }

  // Settle: wait for a signal that proves the surface has finished
  // mounting — not merely that *an* <h1> exists — then for fonts.
  //
  // Editors need special care: ArtifactEditorPage's loading state renders
  // its own `<PageHeader title="Editor">` (an <h1>) and a "Loading…"
  // paragraph, so a generic "first <h1> visible" wait is satisfied by the
  // *loading* DOM and axe/screenshot can run before the real editor chrome
  // and body have mounted (an intermittent contrast flake). The loaded
  // editor — and only the loaded editor — renders a Breadcrumb
  // (`<nav aria-label="Breadcrumb">`), so we key on that to guarantee
  // `loading` has flipped false and the editor tree is committed.
  if (surface.kind === "editor") {
    await page
      .locator('nav[aria-label="Breadcrumb"]')
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  } else {
    await page
      .locator("h1, [role='dialog']")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  }
  await page.evaluate(() => document.fonts.ready);
}
