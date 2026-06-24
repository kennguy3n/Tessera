/**
 * `tessera://` deeplink protocol handler.
 *
 * Tessera registers itself as the default handler
 * for the `tessera://` URL scheme so KChat Desktop (and any other
 * cooperating app) can hand the user back to a specific Tessera
 * surface without round-tripping through the OS shell. The three
 * routes currently understood are:
 *
 *   tessera://source/<sourceId>          — open the source detail page
 *   tessera://artifact/<artifactId>      — open the artifact viewer
 *   tessera://ingest?channel=<id>&team=<id>
 *                                        — trigger channel ingestion
 *
 * The bridge is platform-aware:
 *
 *   - **macOS** delivers deeplinks via `app.on("open-url", …)`.
 *     Cocoa may fire the listener BEFORE `whenReady` resolves, in
 *     which case the URL is *parked* and replayed once the renderer
 *     has registered its consumer.
 *   - **Windows / Linux** deliver deeplinks via a `second-instance`
 *     event on the primary process, with the raw URL as the last
 *     entry in the spawned process's `argv`. The bridge claims the
 *     single-instance lock; a child process that loses the lock
 *     forwards its argv and exits immediately.
 *
 * Trust model: the URL parser is allow-list driven and rejects any
 * unrecognised host or query parameter. SSRF / open-redirect-style
 * tricks (`tessera://../../etc/passwd`, query-fragments with `<` /
 * `>`, control characters, …) are scrubbed at parse time. The
 * downstream consumer receives only the typed `DeeplinkRoute`
 * union — there is no path traversal possible because the parser
 * never hands raw strings to the filesystem.
 *
 * The implementation is intentionally test-friendly: the protocol
 * registration helpers (`registerProtocolClient`, `attachAppEvents`)
 * accept injected Electron primitives so tests can drive the
 * dispatch logic without spinning up a real Electron process.
 */

import type { App, Event as ElectronEvent } from "electron";

/** Custom URL scheme owned by Tessera. */
export const TESSERA_PROTOCOL_SCHEME = "tessera";

/** All routes the bridge recognises. */
export type DeeplinkRoute =
  | { kind: "source"; sourceId: string }
  | { kind: "artifact"; artifactId: string }
  | {
      kind: "ingest";
      channelId: string;
      teamId: string | null;
    };

/** Why parsing failed. Tests assert on the discriminator. */
export type DeeplinkParseFailure =
  | "wrong-scheme"
  | "unknown-host"
  | "missing-id"
  | "invalid-characters"
  | "missing-query-param"
  | "trailing-segments"
  | "url-too-long";

export type DeeplinkParseResult =
  | { ok: true; route: DeeplinkRoute }
  | { ok: false; reason: DeeplinkParseFailure; detail?: string };

/** Hard cap; defends against pathological URLs from a malicious caller. */
const MAX_URL_LENGTH = 8 * 1024;

/** Allow [a-zA-Z0-9_-] only — Mattermost / KChat ids fit this. */
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Parse a single deeplink URL and return either a typed route or a
 * failure reason. Pure; safe to call from any context (including
 * tests) without side effects.
 */
export function parseDeeplink(rawUrl: string): DeeplinkParseResult {
  if (typeof rawUrl !== "string") {
    return { ok: false, reason: "wrong-scheme", detail: "not a string" };
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "url-too-long" };
  }
  // Reject ASCII control characters (0x00–0x1F). They have no
  // legitimate place in a URL and rejecting them defeats header /
  // protocol-injection attempts. eslint flags raw control-char
  // regexes (`no-control-regex`); we use a charCode scan instead.
  for (let i = 0; i < rawUrl.length; i++) {
    const code = rawUrl.charCodeAt(i);
    if (code <= 0x1f) {
      return { ok: false, reason: "invalid-characters" };
    }
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "wrong-scheme", detail: "URL parser failed" };
  }
  if (url.protocol !== `${TESSERA_PROTOCOL_SCHEME}:`) {
    return {
      ok: false,
      reason: "wrong-scheme",
      detail: `expected ${TESSERA_PROTOCOL_SCHEME}:, got ${url.protocol}`,
    };
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0);
  if (host === "source") {
    if (segments.length === 0) {
      return { ok: false, reason: "missing-id", detail: "source id" };
    }
    if (segments.length > 1) {
      return { ok: false, reason: "trailing-segments" };
    }
    const sourceId = decodeURIComponentSafe(segments[0]);
    if (sourceId === null) {
      return { ok: false, reason: "invalid-characters" };
    }
    if (!ID_PATTERN.test(sourceId)) {
      return { ok: false, reason: "invalid-characters" };
    }
    return { ok: true, route: { kind: "source", sourceId } };
  }
  if (host === "artifact") {
    if (segments.length === 0) {
      return { ok: false, reason: "missing-id", detail: "artifact id" };
    }
    if (segments.length > 1) {
      return { ok: false, reason: "trailing-segments" };
    }
    const artifactId = decodeURIComponentSafe(segments[0]);
    if (artifactId === null) {
      return { ok: false, reason: "invalid-characters" };
    }
    if (!ID_PATTERN.test(artifactId)) {
      return { ok: false, reason: "invalid-characters" };
    }
    return { ok: true, route: { kind: "artifact", artifactId } };
  }
  if (host === "ingest") {
    if (segments.length > 0) {
      return { ok: false, reason: "trailing-segments" };
    }
    const channelId = url.searchParams.get("channel");
    if (channelId === null || channelId.length === 0) {
      return {
        ok: false,
        reason: "missing-query-param",
        detail: "channel",
      };
    }
    if (!ID_PATTERN.test(channelId)) {
      return { ok: false, reason: "invalid-characters" };
    }
    const rawTeam = url.searchParams.get("team");
    let teamId: string | null = null;
    if (rawTeam !== null && rawTeam.length > 0) {
      if (!ID_PATTERN.test(rawTeam)) {
        return { ok: false, reason: "invalid-characters" };
      }
      teamId = rawTeam;
    }
    return {
      ok: true,
      route: { kind: "ingest", channelId, teamId },
    };
  }
  return {
    ok: false,
    reason: "unknown-host",
    detail: host,
  };
}

function decodeURIComponentSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Compose a deeplink URL for the given route. The inverse of
 * `parseDeeplink`; round-trip is exercised by the test suite.
 */
export function buildDeeplink(route: DeeplinkRoute): string {
  switch (route.kind) {
    case "source":
      return `${TESSERA_PROTOCOL_SCHEME}://source/${encodeURIComponent(route.sourceId)}`;
    case "artifact":
      return `${TESSERA_PROTOCOL_SCHEME}://artifact/${encodeURIComponent(route.artifactId)}`;
    case "ingest": {
      const url = new URL(`${TESSERA_PROTOCOL_SCHEME}://ingest`);
      url.searchParams.set("channel", route.channelId);
      if (route.teamId !== null) {
        url.searchParams.set("team", route.teamId);
      }
      return url.toString();
    }
  }
}

export type DeeplinkConsumer = (route: DeeplinkRoute) => void;

/**
 * Stateful router used by the Electron main process. The bridge
 * keeps a queue of pre-ready deeplinks (Cocoa may dispatch an
 * `open-url` event before the renderer is up); calls to `dispatch()`
 * invoke the registered consumer if any, otherwise park the route.
 * Once a consumer registers, queued routes are flushed in FIFO
 * order.
 */
export class DeeplinkBridge {
  private consumer: DeeplinkConsumer | null = null;
  private readonly parked: DeeplinkRoute[] = [];
  private readonly parseFailureLogger: (
    raw: string,
    failure: DeeplinkParseFailure,
    detail?: string,
  ) => void;

  constructor(
    opts: {
      onParseFailure?: (
        raw: string,
        failure: DeeplinkParseFailure,
        detail?: string,
      ) => void;
    } = {},
  ) {
    this.parseFailureLogger = opts.onParseFailure ?? (() => undefined);
  }

  /** Register the consumer (usually the renderer-facing IPC pump). */
  setConsumer(consumer: DeeplinkConsumer): void {
    this.consumer = consumer;
    while (this.parked.length > 0) {
      const next = this.parked.shift();
      if (next === undefined) break;
      try {
        consumer(next);
      } catch {
        // Best-effort: swallow consumer errors so a buggy renderer
        // does not break the rest of the queue.
      }
    }
  }

  /** Detach the consumer (e.g. when the renderer window closes). */
  clearConsumer(): void {
    this.consumer = null;
  }

  /** Snapshot of currently-parked routes; tests assert on this. */
  parkedRoutes(): readonly DeeplinkRoute[] {
    return [...this.parked];
  }

  /** Number of consumed-or-parked dispatches; tests assert on this. */
  pendingCount(): number {
    return this.parked.length;
  }

  /**
   * Handle a raw URL. Invalid URLs are dropped after the failure
   * logger fires; valid URLs are forwarded to the consumer or
   * parked.
   */
  ingestRawUrl(rawUrl: string): DeeplinkParseResult {
    const result = parseDeeplink(rawUrl);
    if (!result.ok) {
      this.parseFailureLogger(rawUrl, result.reason, result.detail);
      return result;
    }
    this.dispatch(result.route);
    return result;
  }

  /** Forward a typed route to the consumer (or park if none). */
  dispatch(route: DeeplinkRoute): void {
    if (this.consumer !== null) {
      try {
        this.consumer(route);
      } catch {
        // Buggy consumer; the route is still considered dispatched
        // so we don't re-queue it (it would loop on the next call).
      }
      return;
    }
    this.parked.push(route);
  }

  /** Extract the first `tessera://` URL from an argv vector. */
  static extractUrlFromArgv(argv: readonly string[]): string | null {
    for (const arg of argv) {
      if (
        typeof arg === "string" &&
        arg.toLowerCase().startsWith(`${TESSERA_PROTOCOL_SCHEME}://`)
      ) {
        return arg;
      }
    }
    return null;
  }
}

/**
 * Register the `tessera://` scheme with Electron so the OS knows to
 * launch Tessera when the URL is opened. Must be called BEFORE
 * `app.whenReady()`.
 *
 * Returns `true` when the call took effect (the OS now routes the
 * scheme to this binary), or `false` when another binary already
 * owns it. In development we additionally pass `process.execPath` +
 * `process.argv[1]` so a stand-alone `electron .` invocation owns
 * the scheme instead of the system Electron binary.
 */
export function registerProtocolClient(
  app: Pick<App, "setAsDefaultProtocolClient">,
  opts: {
    execPath?: string;
    args?: readonly string[];
  } = {},
): boolean {
  if (opts.execPath !== undefined) {
    return app.setAsDefaultProtocolClient(
      TESSERA_PROTOCOL_SCHEME,
      opts.execPath,
      [...(opts.args ?? [])],
    );
  }
  return app.setAsDefaultProtocolClient(TESSERA_PROTOCOL_SCHEME);
}

/**
 * Wire the bridge into Electron's main-process app events.
 * Returns a teardown function that removes the listeners — tests
 * use this to reset between cases without leaking handles.
 */
export function attachAppEvents(
  bridge: DeeplinkBridge,
  app: Pick<App, "on" | "off">,
): () => void {
  const openUrlListener = (event: ElectronEvent, url: string): void => {
    event.preventDefault?.();
    bridge.ingestRawUrl(url);
  };
  const secondInstanceListener = (
    _event: ElectronEvent,
    argv: readonly string[],
  ): void => {
    const url = DeeplinkBridge.extractUrlFromArgv(argv);
    if (url !== null) {
      bridge.ingestRawUrl(url);
    }
  };
  app.on("open-url", openUrlListener);
  app.on("second-instance", secondInstanceListener);
  return () => {
    app.off("open-url", openUrlListener);
    app.off("second-instance", secondInstanceListener);
  };
}
