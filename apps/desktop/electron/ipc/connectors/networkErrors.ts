/**
 * Shared network-error classification for all connectors.
 *
 * Lives in a dedicated module — not in `handlers.ts` — for two
 * reasons:
 *
 *   1. `handlers.ts` imports the per-provider sync functions
 *      (`syncNotion`, `syncConfluence`, `syncFigma`, etc.). Those
 *      modules in turn need to call `isNetworkError(err)` in their
 *      per-iteration `catch` blocks so a token-refresh `NetworkError`
 *      propagates out instead of being silently swallowed alongside
 *      benign API errors. If the classifier lived in `handlers.ts`,
 *      those imports would form a cycle.
 *
 *   2. Network-error classification is conceptually one self-contained
 *      module — class, code allowlist, message-pattern fallback,
 *      classifier function — and benefits from being grep-able and
 *      unit-testable in isolation from the connector IPC plumbing.
 */

/**
 * Distinguished error class connectors throw when they have *direct*
 * evidence the host is offline (DNS resolution failed, TCP refused,
 * `fetch` rejected without a status, etc.). Preferring this class over
 * string-matching is the only fully-correct way to classify network
 * errors — the message-based heuristic below is a fallback for
 * third-party libraries that throw plain `Error` objects.
 */
export class NetworkError extends Error {
  /** Branded so duck-type checks survive cross-realm boundaries. */
  readonly isNetworkError = true as const;
  constructor(message: string, options?: { cause?: unknown }) {
    // Forward the cause through the ES2022 `Error` options bag so
    // the V8 engine stores it on the standard `Error.cause` property
    // (writable, non-enumerable). Previously this class declared its
    // own `cause` field and assigned it in the constructor body,
    // which *shadowed* the built-in `Error.cause` — every consumer
    // that read `err.cause` saw the class-owned copy, but anything
    // walking the standard `Error.cause` chain (debuggers, error
    // serializers, structured loggers built on the spec contract)
    // saw `undefined` on `NetworkError` instances. The options-bag
    // form is the only spec-compliant way to set `Error.cause` and
    // it gives us the same `err.cause` read access the previous code
    // already relied on (e.g. `isNetworkError` reading `e.cause?.code`).
    super(message, options);
    this.name = "NetworkError";
  }
}

/**
 * Distinguished error class for *authentication-state* failures —
 * the user is not connected, or their access/refresh token has
 * expired and must be re-issued. These are explicitly NOT network
 * errors: the renderer needs to prompt the user to re-authenticate,
 * not show an "Offline" badge. Carrying this as a distinguished class
 * is what stops `isNetworkError` from confusing "not connected" (auth
 * state) with "connection refused" (transport).
 */
export class NotConnectedError extends Error {
  readonly isNotConnectedError = true as const;
  constructor(message: string) {
    super(message);
    this.name = "NotConnectedError";
  }
}

// Word-boundary patterns for the message-only fallback. We
// deliberately avoid the bare token `connect`: that substring also
// matches "not connected" / "disconnect failed" / "reconnect", which
// are auth/state errors — not transport failures. The patterns below
// only match phrases the Node/undici/Electron fetch stack actually
// produces for genuine offline conditions.
// The `/i` flag is defense-in-depth: the only call site below
// already lowercases via `e.message.toLowerCase()` before testing,
// so the lowercase-only patterns would match in practice. But the
// renderer-side mirror at `ConnectorStatus.tsx:93-96` is a separate
// implementation that must stay in sync, and a future caller that
// forgets to lowercase would silently stop matching uppercase error
// messages. Making the patterns self-contained (case-insensitive)
// removes that latent footgun without affecting today's behaviour.
const NETWORK_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\bfetch failed\b/i,
  /\bnetwork\s+(error|unreachable|down|failure|is\s+offline)\b/i,
  /\bconnection\s+(refused|reset|timed\s*out|timeout|aborted|closed)\b/i,
  /\bdns\s+(lookup|resolution)\s+failed\b/i,
  /\bgetaddrinfo\b/i,
  /\bsocket\s+hang\s+up\b/i,
];

// Network failure codes from libc / Node net / undici. Kept as a
// module-level `Set` (not an array literal allocated on every call)
// so the hot `isNetworkError` path is O(1) lookup with no
// per-invocation allocation. The previous shape was an array literal
// constructed inside `isNetworkError` and scanned with `.includes()`,
// which allocated ~25 entries on every error classification and
// scanned linearly. The `Set` form is the canonical fix for both.
// Maintenance: keep this list in sync with new transport-level error
// codes as the runtime evolves — anything not in the allowlist falls
// through to the message-pattern heuristic above, which is a strictly
// weaker classifier (false positives are easier than with a code
// allowlist).
const NETWORK_CODES: ReadonlySet<string> = new Set([
  // libc / Node
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  // `ECONNABORTED` is the libc/Node counterpart to Chromium's
  // `ERR_CONNECTION_ABORTED` (already listed below). It surfaces
  // when an SO_LINGER timeout, a `request.destroy()` from the
  // server side, or an undici-level `AbortError` close the socket
  // mid-request. The message-pattern heuristic below would catch
  // most user-visible presentations, but the code-level allowlist
  // is the strictly stronger signal and we list the Chromium
  // variant — listing the libc variant here is the cheap completion
  // of the pair.
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  // undici (Node 18+ fetch)
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_REQ_RETRY",
  // Node fetch / Electron
  "ERR_NETWORK",
  "ERR_NETWORK_CHANGED",
  "ERR_NETWORK_IO_SUSPENDED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_ABORTED",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_CONNECTION_FAILED",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "ERR_SOCKET_NOT_CONNECTED",
  "ERR_TIMED_OUT",
]);

export function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // Auth-prerequisite errors must NEVER be reported as "offline" —
  // doing so makes the failure impossible to diagnose from the UI
  // (user clicks Sync, sees Offline badge, retries forever, never
  // realises the actual problem is that they need to re-authenticate).
  if ((err as { isNotConnectedError?: boolean }).isNotConnectedError === true) {
    return false;
  }
  if ((err as { isNetworkError?: boolean }).isNetworkError === true) return true;
  const e = err as { code?: string; message?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code ?? "";
  if (NETWORK_CODES.has(code)) return true;
  if (code !== "") return false;
  const msg = (e.message ?? "").toLowerCase();
  return NETWORK_MESSAGE_PATTERNS.some((re) => re.test(msg));
}
