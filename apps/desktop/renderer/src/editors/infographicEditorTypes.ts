/**
 * Pure type declarations for `InfographicEditor` and its companion modules.
 *
 * Lives in a third file (neither the component file nor the helpers
 * file) so the component and helpers can each import these types
 * directly without creating a runtime cycle. Compile-time-erased
 * declarations only — no value-level code lives here, by design.
 */
import type { HeroImage } from "../utils/heroImage";

export type InfographicLayout = "vertical" | "horizontal" | "grid";

export interface InfographicSection {
  icon?: string; // e.g. "lucide:trending-up"
  heading: string;
  body: string;
  stat?: string;
  statLabel?: string;
}

export interface InfographicColorScheme {
  primary?: string;
  secondary?: string;
  accent?: string;
}

/**
 * Re-export of the shared `HeroImage` type under the editor-local
 * `InfographicHeroImage` alias so existing imports of this type
 * (if any landed in third-party code) keep working. The shared
 * type and the `sanitizeHeroImage` validator both live in
 * `utils/heroImage.ts` — see that file for the rationale behind
 * the `tessera-asset://generated-images/` prefix gate and the five
 * required fields.
 */
export type InfographicHeroImage = HeroImage;

export interface InfographicContent {
  title: string;
  subtitle?: string;
  layout: InfographicLayout;
  colorScheme: InfographicColorScheme;
  defaultIconSet?: "lucide" | "phosphor";
  sections: InfographicSection[];
  heroImage?: HeroImage;
}
