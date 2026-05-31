import { describe, it, expect } from "vitest";

import {
  MAX_INLINE_IMAGE_BYTES,
  fileToDataUrl,
} from "../inlineImage";

// ─────────────────────────────────────────────────────────────────────
// Shared inline-image helper — `fileToDataUrl` + `MAX_INLINE_IMAGE_BYTES`.
//
// This module backs the upload path for BOTH the document editor and
// the slide editor. The slide editor previously had its own hand-rolled
// copy with no size cap (Devin Review PR #82 BUG_…_0001 + ANALYSIS_…_0001).
// The tests below pin the shared contract:
//
//   1. Files at-or-below the cap resolve with a `data:` URL.
//   2. Files larger than the cap reject with a human-readable error
//      that mentions both the file's actual size and the cap, so a
//      caller can surface the message verbatim in a toast.
//   3. A non-string FileReader result (defence in depth — `readAsDataURL`
//      always produces a string, but a future caller swapping to
//      `readAsArrayBuffer` would land here) rejects rather than
//      silently producing a stringified `ArrayBuffer`.
//   4. A FileReader `onerror` rejects with the underlying `error` (or
//      a fallback) so the caller can distinguish "the user revoked the
//      drop" from "the file was too big".
//
// Note: building a 5 MiB `File` instance in a unit test would balloon
// the test process's RSS; instead we stub `size` on a `File`-shaped
// object so the size-check branch fires synchronously before any
// FileReader work, which is the actual code path we care about.
// ─────────────────────────────────────────────────────────────────────

describe("MAX_INLINE_IMAGE_BYTES", () => {
  it("is exactly 5 MiB", () => {
    // Pin the cap so a future tweak in `inlineImage.ts` is forced to
    // come with an explicit test change — keeps the document/slide
    // editors from quietly diverging if someone bumps the cap in just
    // one place. The previous slide-editor BUG was exactly this kind
    // of silent drift (no cap at all on one side).
    expect(MAX_INLINE_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("fileToDataUrl — size cap", () => {
  it("rejects files exceeding MAX_INLINE_IMAGE_BYTES with a human-readable error", async () => {
    const bigFile = {
      size: MAX_INLINE_IMAGE_BYTES + 1,
    } as File;
    await expect(fileToDataUrl(bigFile)).rejects.toThrow(
      /inline-embed cap is 5 MiB/,
    );
  });

  it("includes the file's actual size in MiB in the rejection message", async () => {
    // 7 MiB ≈ 7.0 MiB in the formatted string. We want the user to
    // see "your file is X MiB" so they know whether to re-export at a
    // different resolution / compression.
    const bigFile = {
      size: 7 * 1024 * 1024,
    } as File;
    await expect(fileToDataUrl(bigFile)).rejects.toThrow(/Image is 7\.0 MiB/);
  });

  it("accepts a file exactly at the cap (boundary)", async () => {
    // The check is strict `>` so files at the cap are admitted. Use
    // a tiny stub `File`-shaped value with a stubbed `FileReader`
    // hook so we don't actually allocate 5 MiB.
    const file = new File(["data"], "x.txt", { type: "text/plain" });
    Object.defineProperty(file, "size", {
      value: MAX_INLINE_IMAGE_BYTES,
      configurable: true,
    });
    const url = await fileToDataUrl(file);
    expect(url).toMatch(/^data:text\/plain;/);
  });
});

describe("fileToDataUrl — happy path & error surfacing", () => {
  it("resolves with a base64 data URL for an in-range file", async () => {
    const file = new File(["data"], "hello.txt", { type: "text/plain" });
    const url = await fileToDataUrl(file);
    expect(url).toMatch(/^data:text\/plain;/);
    expect(url).toContain("ZGF0YQ=="); // base64("data")
  });

  it("rejects when FileReader.onerror fires", async () => {
    // Stub the global `FileReader` so we can simulate an error path
    // (e.g. user revoked permissions to a dropped file mid-read).
    const originalReader = globalThis.FileReader;
    class ErrorReader {
      onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      error: DOMException | null = null;
      result: string | ArrayBuffer | null = null;
      readAsDataURL() {
        queueMicrotask(() => {
          this.error = new DOMException("permission revoked", "NotReadableError");
          this.onerror?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>);
        });
      }
    }
    (globalThis as { FileReader: typeof FileReader }).FileReader = ErrorReader as unknown as typeof FileReader;
    try {
      const file = new File(["x"], "x.txt", { type: "text/plain" });
      await expect(fileToDataUrl(file)).rejects.toThrow(/permission revoked/);
    } finally {
      (globalThis as { FileReader: typeof FileReader }).FileReader = originalReader;
    }
  });

  it("rejects when FileReader resolves with a non-string result", async () => {
    // Defence-in-depth: `readAsDataURL` always produces a string in
    // practice but the helper's type-guard catches an ArrayBuffer
    // (which would happen if a future caller swapped the API call).
    const originalReader = globalThis.FileReader;
    class BufferReader {
      onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      error: DOMException | null = null;
      result: string | ArrayBuffer | null = new ArrayBuffer(8);
      readAsDataURL() {
        queueMicrotask(() => {
          this.onload?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>);
        });
      }
    }
    (globalThis as { FileReader: typeof FileReader }).FileReader = BufferReader as unknown as typeof FileReader;
    try {
      const file = new File(["x"], "x.txt", { type: "text/plain" });
      await expect(fileToDataUrl(file)).rejects.toThrow(/non-string/);
    } finally {
      (globalThis as { FileReader: typeof FileReader }).FileReader = originalReader;
    }
  });
});
