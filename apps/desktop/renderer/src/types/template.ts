export interface Template {
  id: string;
  name: string;
  templateType: string;
  description: string;
  sections: TemplateSection[];
  exportFormats: string[];
  /**
   * BCP-47 language tag for the template's section titles and prompts.
   * Defaults to `"en"` for templates that don't carry an explicit override.
   * Localized variants share the same base id with a locale suffix
   * (e.g. `prd-v1-es`, `prd-v1-ja`).
   */
  locale?: string;
  /**
   * Industry domains this template is tailored for (e.g. `"healthcare"`,
   * `"legal"`, `"education"`, `"government"`, `"finance"`,
   * `"manufacturing"`, `"retail"`, `"nonprofit"`, `"creative"`,
   * `"real-estate"`). An empty / missing array means the template is
   * industry-agnostic. Multiple values are permitted for cross-industry
   * templates (e.g. `["legal", "finance"]` for a compliance audit).
   */
  industry?: string[];
  /**
   * Intended user profile(s) this template was authored for (e.g.
   * `"executive"`, `"analyst"`, `"teacher"`, `"nurse"`,
   * `"product-manager"`, `"engineer"`). Used by the CreatePage UI to
   * rank templates by relevance to the current user's profile
   * preferences. An empty / missing array means the template is
   * profile-agnostic.
   */
  profile?: string[];
}

export interface TemplateSection {
  title: string;
  prompt: string;
  requiredSources?: {
    type: string;
    min: number;
  }[];
}
