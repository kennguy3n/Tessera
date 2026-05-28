/**
 * Pure type declarations for `LandingPageEditor` and its companion modules.
 *
 * Lives in a third file (neither the component file nor the helpers
 * file) so the component and helpers can each import these types
 * directly without creating a runtime cycle. Compile-time-erased
 * declarations only — no value-level code lives here, by design.
 */
import type { HeroImage } from "../utils/heroImage";

/**
 * Re-export of the shared `HeroImage` type under the editor-local
 * `LandingPageHeroImage` alias so existing imports of this type
 * (if any landed in third-party code) keep working. The shared
 * type and the `sanitizeHeroImage` validator both live in
 * `utils/heroImage.ts` — see that file for the rationale behind
 * the `tessera-asset://generated-images/` prefix gate and the five
 * required fields.
 */
export type LandingPageHeroImage = HeroImage;

export interface LandingPageHero {
  headline: string;
  subheadline: string;
  cta?: string;
  ctaUrl?: string;
  image?: HeroImage;
}

export interface LandingPageFeature {
  icon?: string;
  title: string;
  description: string;
}

export interface LandingPageStat {
  value: string;
  label: string;
}

export interface LandingPageTestimonial {
  quote: string;
  name: string;
  company?: string;
}

export interface LandingPageCta {
  headline: string;
  buttonText: string;
  buttonUrl?: string;
}

export interface LandingPageContent {
  title: string;
  hero: LandingPageHero;
  features: LandingPageFeature[];
  stats: LandingPageStat[];
  testimonials: LandingPageTestimonial[];
  cta?: LandingPageCta;
  colorScheme: {
    primary?: string;
    secondary?: string;
    accent?: string;
  };
}
