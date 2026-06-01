/**
 * zero-on-free helpers for sensitive buffers.
 *
 * Node.js Buffers are pooled and reused; once a sensitive value (a
 * decrypted secret, a freshly-derived encryption key, a hex-encoded
 * SQLCipher key) is no longer needed we want to overwrite its bytes
 * BEFORE returning the buffer to the pool so a subsequent allocation
 * cannot read residual plaintext out of the slab.
 *
 * V8 may still hold a copy of the value elsewhere in the heap from
 * intermediate computations (e.g. the `String` produced by
 * `.toString("utf-8")`), so zeroing the Buffer is a defense-in-depth
 * mitigation rather than a guarantee — but it is the strongest tool
 * available to us in JS-land and meaningfully shrinks the window
 * during which a heap-dump attacker can recover the value.
 *
 * The functions in this module never throw: a best-effort overwrite
 * is always better than crashing the cleanup path. A `null` or
 * `undefined` is treated as a no-op so callers can put the cleanup
 * call at the top of a `finally` block without first having to
 * initialise the variable.
 */

/**
 * Overwrite every byte of `buf` with zero. Safe to call on
 * `undefined` / `null` — the call returns silently in that case so
 * `finally` blocks can zero buffers that may not have been allocated
 * yet at the time the block fires.
 *
 * `Buffer.fill(0)` writes through the underlying ArrayBuffer storage
 * so subarrays of the same slab also see the overwrite.
 */
export function zeroBuffer(buf: Buffer | null | undefined): void {
  if (!buf) return;
  try {
    buf.fill(0);
  } catch {
    // `Buffer.fill` only throws on a non-Buffer argument — which
    // means the caller passed something we shouldn't be touching
    // anyway. Swallow so cleanup never aborts a `finally` block.
  }
}

/**
 * Convenience: zero each of `bufs` in order. The variadic form keeps
 * cleanup blocks single-line:
 *
 *     try {
 *       const a = decipher.update(ct);
 *       const b = decipher.final();
 *       const plain = Buffer.concat([a, b]);
 *       try {
 *         return plain.toString("utf-8");
 *       } finally {
 *         zeroBuffers(a, b, plain);
 *       }
 *     } …
 *
 * Returns `void` rather than the buffers — the helper is a side-effect
 * sink, not a value-producing combinator.
 */
export function zeroBuffers(
  ...bufs: ReadonlyArray<Buffer | null | undefined>
): void {
  for (const b of bufs) zeroBuffer(b);
}
