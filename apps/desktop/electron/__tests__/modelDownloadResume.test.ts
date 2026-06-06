/**
 * Tests for the resumable HTTP fetcher used by model downloads
 * (`createDefaultFetcher` in modelManagement.ts).
 *
 * Model weights are multi-GB and downloads routinely outlive a flaky
 * connection, so the production fetcher resumes from the bytes already
 * on disk via an HTTP `Range` request instead of restarting. These
 * tests inject a fake `fetch` (returning real `Response` objects backed
 * by `ReadableStream`s) and a real temp file so we exercise the actual
 * range / append / retry logic without touching the network.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { createDefaultFetcher } from "../modelManagement";

let workdir: string;
let dest: string;

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

// Read the `Range` request header straight off the plain object the
// production fetcher passes. We deliberately avoid `new Headers(...)`
// here: `Range` is on the fetch spec's forbidden-header list and some
// `Headers` implementations silently drop it, which would hide the
// very behaviour these tests assert.
function rangeStart(init?: RequestInit): number | null {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const range = headers.Range ?? headers.range;
  if (!range) return null;
  const m = /bytes=(\d+)-/.exec(range);
  return m ? parseInt(m[1], 10) : null;
}

describe("createDefaultFetcher — Range-request resume", () => {
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

    const fetcher = createDefaultFetcher(fetchImpl);
    const result = await fetcher("https://x/model", () => {}, dest);

    expect(calls).toEqual([null]);
    expect(result.totalBytes).toBe(body.length);
    expect(await fsp.readFile(dest)).toEqual(body);
  });

  it("resumes from an existing partial with a Range header and appends (206)", async () => {
    const full = Buffer.from("the quick brown fox jumps over the lazy dog");
    const prefixLen = 10;
    await fsp.writeFile(dest, full.subarray(0, prefixLen));

    const calls: (number | null)[] = [];
    let lastTotal = -1;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const start = rangeStart(init);
      calls.push(start);
      const remainder = full.subarray(start ?? 0);
      return new Response(streamOf(remainder), {
        status: 206,
        headers: {
          "content-length": String(remainder.length),
          "content-range": `bytes ${start}-${full.length - 1}/${full.length}`,
        },
      });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl);
    const result = await fetcher(
      "https://x/model",
      (downloaded, total) => {
        lastTotal = total;
      },
      dest,
    );

    expect(calls).toEqual([prefixLen]);
    expect(result.totalBytes).toBe(full.length);
    // Progress total is the absolute resource size, not the remainder.
    expect(lastTotal).toBe(full.length);
    expect(await fsp.readFile(dest)).toEqual(full);
  });

  it("retries a mid-stream interruption and resumes via Range", async () => {
    const full = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    const calls: (number | null)[] = [];
    let attempt = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const start = rangeStart(init) ?? 0;
      calls.push(rangeStart(init));
      attempt += 1;
      if (attempt === 1) {
        // Drop after delivering ~12 bytes of the full body.
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

    const fetcher = createDefaultFetcher(fetchImpl);
    const result = await fetcher("https://x/model", () => {}, dest);

    expect(attempt).toBe(2);
    // First call had no Range; the retry resumed from the prefix.
    expect(calls[0]).toBeNull();
    expect(calls[1]).toBeGreaterThan(0);
    expect(result.totalBytes).toBe(full.length);
    expect(await fsp.readFile(dest)).toEqual(full);
  });

  it("restarts from scratch when the server ignores Range and replies 200", async () => {
    const full = Buffer.from("AAAABBBBCCCCDDDDEEEE");
    // A stale/garbage prefix that must be discarded, not appended to.
    await fsp.writeFile(dest, Buffer.from("XXXXXXXX"));

    const fetchImpl = (async (_url: string, _init?: RequestInit) => {
      // Server does not support ranges: always full body, status 200.
      return new Response(streamOf(full), {
        status: 200,
        headers: { "content-length": String(full.length) },
      });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl);
    const result = await fetcher("https://x/model", () => {}, dest);

    expect(result.totalBytes).toBe(full.length);
    // File is exactly the full body — the stale prefix was truncated,
    // not concatenated.
    expect(await fsp.readFile(dest)).toEqual(full);
  });

  it("recovers from a 416 by discarding the partial and restarting", async () => {
    const full = Buffer.from("fresh-and-correct-bytes");
    // Existing partial is LARGER than the (shrunken) remote resource,
    // which makes the ranged request unsatisfiable.
    await fsp.writeFile(dest, Buffer.alloc(full.length + 50, 0x5a));

    let sawRange = false;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (rangeStart(init) !== null) {
        sawRange = true;
        return new Response(null, { status: 416 });
      }
      return new Response(streamOf(full), {
        status: 200,
        headers: { "content-length": String(full.length) },
      });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl);
    const result = await fetcher("https://x/model", () => {}, dest);

    expect(sawRange).toBe(true);
    expect(result.totalBytes).toBe(full.length);
    expect(await fsp.readFile(dest)).toEqual(full);
  });

  it("throws a non-OK HTTP status without retrying", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl);
    await expect(
      fetcher("https://x/model", () => {}, dest),
    ).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
  });

  it("gives up after exhausting retries on repeated connection failures", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const fetcher = createDefaultFetcher(fetchImpl, 3);
    await expect(
      fetcher("https://x/model", () => {}, dest),
    ).rejects.toThrow(/ECONNRESET/);
    expect(calls).toBe(3);
  });
});
