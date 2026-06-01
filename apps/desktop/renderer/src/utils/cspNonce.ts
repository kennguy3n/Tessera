/**
 * renderer-side accessor for the per-session CSP
 * nonce. Components that emit an inline `<style>{…}</style>` block
 * read this and pass it as the `nonce` attribute:
 *
 *     import { useCspNonce } from "../utils/cspNonce";
 *     // …
 *     const nonce = useCspNonce();
 *     return (
 *       <>
 *         <div className="my-component">…</div>
 *         <style nonce={nonce}>{`…`}</style>
 *       </>
 *     );
 *
 * The value is set by `preload.ts` at context-bridge time, BEFORE
 * the renderer bundle's JS executes. Reading it during a render is
 * therefore deterministic and synchronous — there is no async race.
 *
 * The hook returns `undefined` (not `""`) when the global is missing
 * so React passes `nonce={undefined}` (which omits the attribute
 * entirely) rather than `nonce=""` (which sets a literal empty
 * attribute that a strict CSP rejects). Both outcomes fail the CSP
 * check, but `nonce={undefined}` keeps the DOM cleaner in DevTools.
 */
export function useCspNonce(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = (window as Window).tesseraCspNonce;
  return value ? value : undefined;
}
