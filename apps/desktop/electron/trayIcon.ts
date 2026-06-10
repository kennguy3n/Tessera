import { nativeImage, type NativeImage } from "electron";

/**
 * LW-9 (minimize-to-tray): the tray icon, embedded as a base64 PNG.
 *
 * Why embedded rather than a shipped asset file: the packaging globs
 * (`packaging/electron-builder.yml`) bundle the *compiled* output
 * (`dist-electron/**`, `renderer-dist/**`) — and `tsc` does not copy
 * non-TS files into `dist-electron`. Shipping a standalone PNG would
 * therefore need a bespoke copy step in the build script (and a
 * matching `files:` glob) purely to carry a <0.5 KB image. Inlining the
 * icon as a data URL keeps it self-contained inside the main bundle so
 * it is present in every build and packaged artifact with zero extra
 * wiring, and makes the tray testable without a filesystem dependency.
 *
 * The glyph is a "T" knocked out of a rounded square, rendered as a
 * black-on-transparent **template** image: on macOS, marking it
 * `setTemplateImage(true)` lets the system tint it for the light/dark
 * menu bar automatically (the AppKit convention). Windows / Linux use
 * the same bitmap as-is.
 */
const TRAY_ICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA9ElEQVRYw+2WMQ6CMBSGP4izq5NxMBhc" +
  "kQP0GibeiIWbeABPAmHAAxiPoANp0gAF2pQ62D95Ca/J4//SvuGHIL0iIAMKoAI+htUCJZDbmCeWprp" +
  "qgHSpuXBo3C8xZ56uaC4rmQJoPABUdPs1UO7BXFYmTWMF4LZ0SRzoOnbYThDvDA2OC55hcAMHjzdwkh" +
  "+bhQMX4KX0b6BW+jOwVfq9DZXJEt17sw/D+Y8cjPmxAkAACAABQAWorf9irufYYYG/PFCOAWQeAUaTc" +
  "oTbJDyVkLVKPADMxnOxormYM5dKcZuQK2biuE453ca2lqYF3XJHZrb/pC9yD1Oob3ZuMwAAAABJRU5E" +
  "rkJggg==";

/**
 * Build the tray `NativeImage` from the embedded PNG. Marked as a
 * template image so macOS tints it for the menu bar; a no-op on
 * Windows / Linux. Returns a fresh image each call (cheap — the buffer
 * is tiny) so callers never share mutable native state.
 */
export function createTrayImage(): NativeImage {
  const image = nativeImage.createFromBuffer(
    Buffer.from(TRAY_ICON_PNG_BASE64, "base64"),
  );
  // Template images adapt to the menu-bar appearance on macOS; ignored
  // elsewhere. Guard the call so a stubbed `nativeImage` in tests that
  // returns a bare object doesn't throw.
  if (typeof image.setTemplateImage === "function") {
    image.setTemplateImage(true);
  }
  return image;
}
