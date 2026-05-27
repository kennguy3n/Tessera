/**
 * Shared KChat server-URL SSRF guard.
 *
 * Both the PAT path (`ipc/kchat.ts` → `enforceKchatServerUrl`) and
 * the extension-bridge path (`kchatExtensionSession.ts`) accept a
 * KChat server URL — the PAT path from the operator-typed text
 * input, the extension path from the `uney-chat-desktop` handshake
 * response. Both need to apply the same SSRF policy:
 *
 *   - Reject literal private / loopback / link-local IP addresses
 *     in any IPv4 form `getaddrinfo` accepts (dotted, dotted-hex,
 *     dotted-octal, single-integer, 2-/3-part) and in the IPv6
 *     unique-local / link-local / loopback / IPv4-mapped forms.
 *   - Resolve the hostname through DNS and reject if any A/AAAA
 *     record lands in private/loopback space (closes the
 *     intranet split-horizon and DNS-rebinding-without-TLS gap).
 *   - Fail-closed on DNS errors other than `ENOTFOUND` /
 *     `EAI_NONAME` — those two surface the network-layer error
 *     to the user, anything else (timeout, SERVFAIL, malformed)
 *     refuses the connect so a slow/hostile resolver cannot bypass
 *     the guard.
 *
 * The functions were extracted from `ipc/kchat.ts` so the
 * `kchat/` subdirectory can import them without creating a circular
 * dependency on `ipc/`. The behaviour is unchanged from the
 * twelfth-pass Devin-Review-hardened version that landed in PRs
 * #42–#43; see the commit log there for the rationale on each
 * branch of the literal check.
 */
import { promises as dnsPromises } from "dns";

/**
 * Parse a single IPv4 token under the rules `getaddrinfo` accepts
 * for non-dotted-decimal forms:
 *
 *   - `"0"` or a non-zero decimal that does NOT start with `0`
 *   - `"0o…"` / leading-zero decimal interpreted as octal (`017` → 15)
 *   - `"0x…"` / `"0X…"` hex
 *
 * Empty string, signed values, anything containing `_` or
 * whitespace, scientific notation, and BigInt-style suffixes
 * return `null`.
 */
function parseIpv4Token(tok: string): number | null {
  if (tok.length === 0) return null;
  if (/[^0-9a-fA-FxX]/.test(tok)) return null;
  let n: number;
  if (/^0[xX]/.test(tok)) {
    if (!/^0[xX][0-9a-fA-F]+$/.test(tok)) return null;
    n = Number.parseInt(tok.slice(2), 16);
  } else if (tok.length > 1 && tok.startsWith("0")) {
    if (!/^0[0-7]+$/.test(tok)) return null;
    n = Number.parseInt(tok.slice(1), 8);
  } else {
    if (!/^[0-9]+$/.test(tok)) return null;
    n = Number.parseInt(tok, 10);
  }
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Canonicalise any of the IPv4 forms `getaddrinfo` accepts to
 * `[a, b, c, d]` (each 0–255), or `null` if `s` is not a valid IPv4
 * literal under those rules. See `ipc/kchat.ts` git history for the
 * full table of accepted shapes.
 */
function parseIpv4(s: string): [number, number, number, number] | null {
  if (s.length === 0) return null;
  const parts = s.split(".");
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const v = parseIpv4Token(p);
    if (v === null) return null;
    nums.push(v);
  }
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] > 0xff) return null;
  }
  const last = nums[nums.length - 1];
  const lastMaxBits = (5 - nums.length) * 8;
  if (last < 0 || last > 2 ** lastMaxBits - 1) return null;
  const a = nums.length >= 2 ? nums[0] : (last >>> 24) & 0xff;
  const b = nums.length >= 3 ? nums[1] : (last >>> 16) & 0xff;
  const c = nums.length >= 4 ? nums[2] : (last >>> 8) & 0xff;
  const d = last & 0xff;
  return [a, b, c, d];
}

/**
 * Return `true` when `hostname` is a literal IP in private,
 * loopback, link-local, or otherwise reserved RFC-1918-style space,
 * or one of the reserved hostnames (`localhost`, `*.localhost`).
 *
 * Coverage:
 *   - IPv4 loopback (127.0.0.0/8), 0.0.0.0/8
 *   - RFC1918 private (10/8, 172.16/12, 192.168/16)
 *   - RFC6598 CGNAT (100.64/10)
 *   - Link-local (169.254/16)
 *   - All of the above in their non-dotted-decimal encodings
 *   - IPv6 loopback (::1, ::) and unspecified
 *   - IPv6 ULA (fc00::/7 → `fc*`, `fd*`)
 *   - IPv6 link-local (fe80::/10 → `fe80:`)
 *   - IPv4-mapped IPv6 (`::ffff:<ipv4>`) in both decimal-tail and
 *     hex-tail forms
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v4 = parseIpv4(h);
  if (v4) {
    const [a, b] = v4;
    if (a === 0) return true;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (h === "::1" || h === "::") return true;
  const isV6Literal = h.includes(":");
  if (isV6Literal) {
    if (h.startsWith("fe80:")) return true;
    if (h.startsWith("fc") || h.startsWith("fd")) return true;
  }
  const mappedDec = h.match(
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (mappedDec) return isPrivateOrLoopbackHost(mappedDec[1]);
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      const a = (hi >>> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >>> 8) & 0xff;
      const d = lo & 0xff;
      return isPrivateOrLoopbackHost(`${a}.${b}.${c}.${d}`);
    }
  }
  return false;
}

/**
 * Validate `rawUrl` is a public-facing `http(s):` URL — reject
 * non-http schemes, reject hostnames that resolve to private /
 * loopback / link-local addresses, fail-closed on DNS errors other
 * than `ENOTFOUND`. Set `TESSERA_KCHAT_ALLOW_INTERNAL=1` to bypass
 * the guard for dev/local use.
 *
 * Returns the parsed `URL` on success; throws an `Error` whose
 * message is safe to surface to the renderer (no token data).
 *
 * Used by both the PAT-path `kchat:connect` IPC handler and the
 * extension-bridge handshake to validate the `serverUrl` we receive
 * from `uney-chat-desktop`. Same code path, same SSRF policy.
 */
export async function enforceKchatServerUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("serverUrl is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("serverUrl must use http:// or https://");
  }
  const allowInternal = process.env.TESSERA_KCHAT_ALLOW_INTERNAL === "1";
  if (allowInternal) {
    return parsed;
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new Error(
      "serverUrl points at a private, loopback, or link-local address; refusing to connect to internal targets. Set TESSERA_KCHAT_ALLOW_INTERNAL=1 to override (dev only).",
    );
  }
  try {
    const addrs = await dnsPromises.lookup(parsed.hostname, { all: true });
    for (const a of addrs) {
      if (isPrivateOrLoopbackHost(a.address)) {
        throw new Error(
          `serverUrl resolves to a private/loopback address (${a.address}); refusing to connect to internal targets. Set TESSERA_KCHAT_ALLOW_INTERNAL=1 to override (dev only).`,
        );
      }
    }
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.startsWith("serverUrl resolves to a private")
    ) {
      throw err;
    }
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "ENOTFOUND" || code === "EAI_NONAME") {
      return parsed;
    }
    throw new Error(
      `serverUrl could not be validated against the SSRF guard (DNS error: ${code || "unknown"}); refusing to connect. Retry once the DNS resolver is reachable, or set TESSERA_KCHAT_ALLOW_INTERNAL=1 to override (dev only).`,
    );
  }
  return parsed;
}
