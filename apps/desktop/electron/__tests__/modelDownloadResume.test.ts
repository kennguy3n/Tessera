/**
 * Tests for the resumable HTTP fetcher used by model downloads
 * (`createDefaultFetcher` in modelManagement.ts).
 *
 * Model weights are multi-GB and downloads routinely outlive a flaky
 * connection, so the production fetcher resumes from the bytes it has
 * written *during this call* via an HTTP `Range` request instead of
 * restarting. Resume is deliberately scoped to a single call: a
 * pre-existing `.partial` from a previous process is NOT trusted (its
 * content identity can't be proven), so a fresh call always re-downloads
 * clean. These tests inject a fake `fetch` (returning real `Response`
 * objects backed by `ReadableStream`s) and a no-op `sleep`, against a
 * real temp file, so we exercise the actual range / append / retry logic
 * without touching the network or waiting on backoff timers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  createDefaultFetcher,
  DownloadAbortedError,
  isDownloadAbortedError,
} from "../modelManagement";

let workdir: string;
let dest: string;

/** Skip the real exponential backoff so retry tests run instantly. */
const noSleep = async (): Promise<void> => undefined;

beforeEach(async () => {
  workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "tessera-resume-"));
  dest = path.join(workdir, "model.gguf.partial");
});

afterEach(async () => {
  await fsp.rm(workdir, { recursive: true, force: true });
});

/**
 * Build a `ReadableStream` that yields `buf` in fixed-size chunks. When
 * `failAfter` is set, the stream errors on the pull *after* it has
 * emitted at least that many bytes — simulating a mid-stream socket
 * drop that still delivered a usable prefix.
 */
function streamOf(
  buf: Buffer,
  opts: { chunkSize?: number; failAfter?: number } = {},
): ReadableStream<Uint8Array> {
  const chunkSize = opts.chunkSize ?? 4;
  let offset = 0;
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && emitted >= opts.failAfter) {
        controller.error(new Error("simulated mid-stream drop"));
        return;
      }
      if (offset >= buf.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, buf.length);
      const chunk = buf.subarray(offset, end);
      offset = end;
      emitted += chunk.length;
      controller.enqueue(new Uint8Array(chunk));
    },
  });
}

// Read request headers straight off the plain object the production
// fetcher passes. We deliberately avoid `new Headers(...)` here: `Range`
// is on the fetch spec's forbidden-header list and some `Headers`
// implementations silently drop it, which would hide the very behaviour
// these tests assert.
function reqHeaders(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function rangeStart(init?: RequestInit): number | null {
  const headers = reqHeaders(init);
  const range = headers.Range ?? headers.range;
  if (!range) return null;
  const m = /bytes=(\d+)-/.exec(range);
  return m ? parseInt(m[1], 10) : null;
}

function ifRange(init?: RequestInit): string | null {
  const headers = reqHeaders(init);
  return headers["If-Range"] ?? headers["if-range"] ?? null;
}

describe("createDefaultFetcher — in-session Range resume", () => {
  it("issues a plain GET (no Range) for a fresh download", async () => {
    const body = Buffer.from("hello world payload");
    const calls: (number | null)[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push(rangeStart(init));
      return new Response(streamOf(body), {
        status: 200,
        headers: { "content-length": String(body.length) },
      });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, undefined, noSleep);
    const result = await fetcher("https://x/model", () => {}, dest);

    expect(calls).toEqual([null]);
    expect(result.totalBytes).toBe(body.length);
    expect(await fsp.readFile(dest)).toEqual(body);
  });

  it("does NOT resume a pre-existing partial across calls (re-downloads clean)", async () => {
    const full = Buffer.from("the quick brown fox jumps over the lazy dog");
    // A `.partial` left behind by a previous process/crash. Its content
    // identity cannot be proven (the same filename is reused across model
    // versions), so the fetcher must ignore it and download from scratch
    // rather than append a new suffix onto a stale prefix.
    await fsp.writeFile(dest, Buffer.from("STALE-PREFIX-BYTES"));

    const calls: (number | null)[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push(rangeStart(init));
      return new Response(streamOf(full), {
        status: 200,
        headers: { "content-length": String(full.length) },
      });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, undefined, noSleep);
    const result = await fetcher("https://x/model", () => {}, dest);

    // Plain GET, no Range — the stale prefix is not trusted.
    expect(calls).toEqual([null]);
    expect(result.totalBytes).toBe(full.length);
    // File is exactly the fresh body, with the stale prefix truncated.
    expect(await fsp.readFile(dest)).toEqual(full);
  });

  it("resumes after a mid-stream drop and appends (206)", async () => {
    const full = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    const calls: (number | null)[] = [];
    let attempt = 0;
    let lastTotal = -1;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const start = rangeStart(init) ?? 0;
      calls.push(rangeStart(init));
      attempt += 1;
      if (attempt === 1) {
        // First attempt: full body (200) that drops after ~12 bytes.
        return new Response(streamOf(full, { failAfter: 12 }), {
          status: 200,
          headers: { "content-length": String(full.length) },
        });
      }
      const remainder = full.subarray(start);
      return new Response(streamOf(remainder), {
        status: 206,
        headers: {
          "content-length": String(remainder.length),
          "content-range": `bytes ${start}-${full.length - 1}/${full.length}`,
        },
      });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, undefined, noSleep);
    const result = await fetcher(
      "https://x/model",
      (_downloaded, total) => {
        lastTotal = total;
      },
      dest,
    );

    expect(attempt).toBe(2);
    // First call had no Range; the retry resumed from the prefix.
    expect(calls[0]).toBeNull();
    expect(calls[1]).toBeGreaterThan(0);
    expect(result.totalBytes).toBe(full.length);
    // Progress total is the absolute resource size, not the remainder.
    expect(lastTotal).toBe(full.length);
    expect(await fsp.readFile(dest)).toEqual(full);
  });

  it("echoes If-Range with the captured validator on resume", async () => {
    const full = Buffer.from("validator-guarded-resume-body-xyz");
    const etag = '"v1-abc123"';
    const ifRanges: (string | null)[] = [];
    let attempt = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      ifRanges.push(ifRange(init));
      attempt += 1;
      if (attempt === 1) {
        return new Response(streamOf(full, { failAfter: 12 }), {
          status: 200,
          headers: { "content-length": String(full.length), etag },
        });
      }
      const start = rangeStart(init) ?? 0;
      const remainder = full.subarray(start);
      return new Response(streamOf(remainder), {
        status: 206,
        headers: {
          "content-length": String(remainder.length),
          "content-range": `bytes ${start}-${full.length - 1}/${full.length}`,
        },
      });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, undefined, noSleep);
    const result = await fetcher("https://x/model", () => {}, dest);

    expect(attempt).toBe(2);
    // First attempt has no If-Range; the resume echoes the captured ETag
    // so the server can fall back to a full 200 if the resource changed.
    expect(ifRanges[0]).toBeNull();
    expect(ifRanges[1]).toBe(etag);
    expect(result.totalBytes).toBe(full.length);
    expect(await fsp.readFile(dest)).toEqual(full);
  });

  it("truncates and restarts when a resume gets a 200 (range ignored)", async () => {
    const full = Buffer.from("AAAABBBBCCCCDDDDEEEEFFFF");
    let attempt = 0;
    const fetchImpl = (async (_url: string, _init?: RequestInit) => {
      attempt += 1;
      if (attempt === 1) {
        // Drop after 8 bytes so the next attempt tries to resume.
        return new Response(streamOf(full, { failAfter: 8 }), {
          status: 200,
          headers: { "content-length": String(full.length) },
        });
      }
      // Server ignores the Range header and replays the whole body.
      return new Response(streamOf(full), {
        status: 200,
        headers: { "content-length": String(full.length) },
      });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, undefined, noSleep);
    const result = await fetcher("https://x/model", () => {}, dest);

    expect(attempt).toBe(2);
    expect(result.totalBytes).toBe(full.length);
    // File is exactly the full body — the 8-byte prefix was truncated,
    // not concatenated with a second full copy.
    expect(await fsp.readFile(dest)).toEqual(full);
  });

  it("recovers from a 416 on resume by discarding bytes and restarting", async () => {
    const full = Buffer.from("fresh-and-correct-bytes-after-416");
    const sawRange: boolean[] = [];
    let attempt = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      attempt += 1;
      const ranged = rangeStart(init) !== null;
      sawRange.push(ranged);
      if (attempt === 1) {
        // Write a prefix, then drop, so attempt 2 sends a Range.
        return new Response(streamOf(full, { failAfter: 12 }), {
          status: 200,
          headers: { "content-length": String(full.length) },
        });
      }
      if (ranged) {
        // Range unsatisfiable (resource is now shorter than our offset).
        return new Response(null, { status: 416 });
      }
      // Post-416 restart: plain GET serves the (fresh) full body.
      return new Response(streamOf(full), {
        status: 200,
        headers: { "content-length": String(full.length) },
      });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, undefined, noSleep);
    const result = await fetcher("https://x/model", () => {}, dest);

    // GET (drop) → ranged (416) → GET (full).
    expect(sawRange).toEqual([false, true, false]);
    expect(result.totalBytes).toBe(full.length);
    expect(await fsp.readFile(dest)).toEqual(full);
  });

  it("throws a non-OK HTTP status without retrying", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, undefined, noSleep);
    await expect(fetcher("https://x/model", () => {}, dest)).rejects.toThrow(
      /HTTP 404/,
    );
    expect(calls).toBe(1);
  });

  it("gives up after exhausting retries on repeated connection failures", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, 3, noSleep);
    await expect(fetcher("https://x/model", () => {}, dest)).rejects.toThrow(
      /ECONNRESET/,
    );
    expect(calls).toBe(3);
  });

  it("backs off with exponential delay between retries", async () => {
    const delays: number[] = [];
    const recordSleep = async (ms: number): Promise<void> => {
      delays.push(ms);
    };
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, 4, recordSleep);
    await expect(fetcher("https://x/model", () => {}, dest)).rejects.toThrow(
      /ECONNRESET/,
    );

    expect(calls).toBe(4);
    // Sleep runs before attempts 1, 2, 3 (not before the first attempt).
    expect(delays).toEqual([500, 1000, 2000]);
  });
});

describe("createDefaultFetcher — AbortSignal cancellation", () => {
  it("passes the signal into fetch so the request is cancellable", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const body = Buffer.from("payload");
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response(streamOf(body), {
        status: 200,
        headers: { "content-length": String(body.length) },
      });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, undefined, noSleep);
    await fetcher("https://x/model", () => {}, dest, controller.signal);

    expect(seen).toBe(controller.signal);
  });

  it("leaves the request's abort signal undefined when none is supplied", async () => {
    // The fetcher always builds `init = { signal }`; when the caller
    // opts out of cancellation the value is `undefined`, which `fetch`
    // treats identically to an absent signal (no active AbortSignal).
    // We assert the value rather than key presence so the intent —
    // "no signal is in effect" — is captured precisely.
    const body = Buffer.from("payload");
    let observedSignal: AbortSignal | null | undefined = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      observedSignal = init?.signal;
      return new Response(streamOf(body), {
        status: 200,
        headers: { "content-length": String(body.length) },
      });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, undefined, noSleep);
    await fetcher("https://x/model", () => {}, dest);

    expect(observedSignal).toBeUndefined();
  });

  it("throws immediately (no fetch) when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new DownloadAbortedError("Download cancelled by user"));
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(streamOf(Buffer.from("x")), { status: 200 });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, undefined, noSleep);
    await expect(
      fetcher("https://x/model", () => {}, dest, controller.signal),
    ).rejects.toThrow(DownloadAbortedError);
    // The pre-attempt checkpoint short-circuits before issuing a request.
    expect(calls).toBe(0);
  });

  it("does NOT retry an abort raised by fetch — it propagates terminally", async () => {
    const controller = new AbortController();
    let calls = 0;
    // Simulate undici rejecting the in-flight request with an AbortError
    // (the stock shape when a signal aborts without an explicit reason).
    const fetchImpl = (async () => {
      calls += 1;
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, 4, noSleep);
    const err = await fetcher(
      "https://x/model",
      () => {},
      dest,
      controller.signal,
    ).catch((e: unknown) => e);

    // A stock AbortError is classified as a cancellation, so it is
    // rethrown on the FIRST attempt instead of consuming all retries.
    expect(isDownloadAbortedError(err)).toBe(true);
    expect(calls).toBe(1);
  });

  it("aborts mid-stream and stops reading the body", async () => {
    const controller = new AbortController();
    const full = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    // A stream that aborts the controller partway through, then errors
    // with the signal's reason on the next pull — mirroring how undici's
    // body reader rejects once the request signal fires.
    const abortingStream = (): ReadableStream<Uint8Array> => {
      let offset = 0;
      const chunkSize = 4;
      return new ReadableStream<Uint8Array>({
        pull(c) {
          if (controller.signal.aborted) {
            c.error(controller.signal.reason);
            return;
          }
          if (offset >= 12) {
            controller.abort(
              new DownloadAbortedError("Download cancelled by user"),
            );
            c.error(controller.signal.reason);
            return;
          }
          const end = Math.min(offset + chunkSize, full.length);
          c.enqueue(new Uint8Array(full.subarray(offset, end)));
          offset = end;
        },
      });
    };
    const fetchImpl = (async () =>
      new Response(abortingStream(), {
        status: 200,
        headers: { "content-length": String(full.length) },
      })) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, 4, noSleep);
    const err = await fetcher(
      "https://x/model",
      () => {},
      dest,
      controller.signal,
    ).catch((e: unknown) => e);

    // The mid-stream abort is terminal (not retried as a transient drop).
    expect(isDownloadAbortedError(err)).toBe(true);
  });
});

describe("isDownloadAbortedError", () => {
  it("recognises our DownloadAbortedError", () => {
    expect(isDownloadAbortedError(new DownloadAbortedError())).toBe(true);
  });

  it("recognises a stock AbortError (no explicit reason)", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isDownloadAbortedError(err)).toBe(true);
  });

  it("does not misclassify ordinary network failures", () => {
    expect(isDownloadAbortedError(new Error("ECONNRESET"))).toBe(false);
    expect(isDownloadAbortedError(null)).toBe(false);
    expect(isDownloadAbortedError("AbortError")).toBe(false);
  });
});
