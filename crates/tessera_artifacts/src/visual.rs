//! Infographic & Landing Page artifact generators.
//!
//! These produce structured Markdown that the renderer turns into rich
//! visual content (icons + cards + stats). The Markdown is the source of
//! truth — editors round-trip it into structured state via parsers in
//! `apps/desktop/renderer/src/editors/`.
//!
//! Output convention
//! -----------------
//! - Each section uses an icon token (`{{icon:lucide:bar-chart-3}}`)
//!   that the renderer / export pipeline resolves to inline SVG via
//!   `iconResolver.ts`.
//! - Stats render as `**42** label` lines so the renderer can pick them
//!   up with a `(\*\*[\d,.+%]+\*\*)\s+(.+)` regex.
//! - Layout hints live in front-matter under `tessera:`.

use std::fmt::Write;
use tessera_core::error::Result;

use crate::generator::{GeneratedContent, GeneratedSection, SourcePack};
use tessera_core::ArtifactType;

#[derive(Debug, Clone, Copy)]
pub enum InfographicLayout {
    Vertical,
    Horizontal,
    Grid,
}

impl InfographicLayout {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Vertical => "vertical",
            Self::Horizontal => "horizontal",
            Self::Grid => "grid",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct InfographicColorScheme {
    pub primary: Option<String>,   // hex e.g. "#7C3AED"
    pub secondary: Option<String>, // hex
    pub accent: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InfographicSpec<'a> {
    pub title: &'a str,
    pub subtitle: Option<&'a str>,
    pub layout: InfographicLayout,
    pub color_scheme: InfographicColorScheme,
    /// Optional default icon set ("lucide" or "phosphor") used when a
    /// section doesn't specify one. Defaults to "lucide".
    pub default_icon_set: Option<&'a str>,
    pub source_packs: &'a [SourcePack],
}

#[derive(Debug, Clone)]
pub struct LandingPageSpec<'a> {
    pub title: &'a str,
    pub hero_headline: &'a str,
    pub hero_subheadline: &'a str,
    pub hero_cta: Option<&'a str>,
    pub features: &'a [SourcePack],
    /// Optional stats (number, label).
    pub stats: &'a [(String, String)],
}

/// Generate a structured Infographic from one or more source packs. Each
/// pack becomes a section with: an icon hint, a heading, a short body
/// (first 2–3 sentences of the top chunk), and an optional stat (number
/// extracted from the chunk via regex).
pub fn generate_infographic(spec: &InfographicSpec<'_>) -> Result<GeneratedContent> {
    let default_set = spec.default_icon_set.unwrap_or("lucide");

    // Front-matter: layout & color scheme so the editor can round-trip.
    let mut front = String::from("---\ntessera:\n  kind: infographic\n");
    let _ = writeln!(front, "  layout: {}", spec.layout.as_str());
    if let Some(p) = &spec.color_scheme.primary {
        let _ = writeln!(front, "  primary: \"{p}\"");
    }
    if let Some(s) = &spec.color_scheme.secondary {
        let _ = writeln!(front, "  secondary: \"{s}\"");
    }
    if let Some(a) = &spec.color_scheme.accent {
        let _ = writeln!(front, "  accent: \"{a}\"");
    }
    front.push_str("---\n\n");

    let mut sections = Vec::with_capacity(1 + spec.source_packs.len());
    sections.push(GeneratedSection {
        heading: "__frontmatter__".to_string(),
        body: front,
        citation_refs: Vec::new(),
    });

    if let Some(subtitle) = spec.subtitle {
        sections.push(GeneratedSection {
            heading: "Overview".to_string(),
            body: format!("> {subtitle}\n"),
            citation_refs: Vec::new(),
        });
    }

    for pack in spec.source_packs {
        let icon_name = suggest_icon_for(&pack.section_title);
        let mut body = String::new();
        let _ = writeln!(body, "{{{{icon:{default_set}:{icon_name} size=32}}}}\n");

        if let Some(stat) = extract_stat(&pack.chunks) {
            let _ = writeln!(body, "**{}** {}", stat.0, stat.1);
            body.push('\n');
        }

        if let Some(first) = pack.chunks.first() {
            let excerpt = first_two_sentences(&first.content);
            let _ = writeln!(body, "{excerpt}");
        } else {
            body.push_str("*Add a source for this section.*\n");
        }

        let refs: Vec<String> = pack
            .chunks
            .iter()
            .enumerate()
            .take(3)
            .map(|(i, c)| format!("[{}] {}", i + 1, c.source_path))
            .collect();

        sections.push(GeneratedSection {
            heading: pack.section_title.clone(),
            body,
            citation_refs: refs,
        });
    }

    Ok(GeneratedContent {
        title: spec.title.to_string(),
        artifact_type: ArtifactType::Infographic,
        sections,
    })
}

/// Generate a Landing Page (hero + features + stats) as structured
/// Markdown. The Landing-Page editor parses this back into UI state.
pub fn generate_landing_page(spec: &LandingPageSpec<'_>) -> Result<GeneratedContent> {
    let mut front = String::from("---\ntessera:\n  kind: landing_page\n---\n\n");

    let mut sections = Vec::new();
    sections.push(GeneratedSection {
        heading: "__frontmatter__".to_string(),
        body: front.split_off(0),
        citation_refs: Vec::new(),
    });

    // Hero
    let mut hero_body = String::new();
    let _ = writeln!(hero_body, "# {}\n", spec.hero_headline);
    let _ = writeln!(hero_body, "{}\n", spec.hero_subheadline);
    if let Some(cta) = spec.hero_cta {
        let _ = writeln!(hero_body, "[{cta}](#cta)\n");
    }
    sections.push(GeneratedSection {
        heading: "Hero".to_string(),
        body: hero_body,
        citation_refs: Vec::new(),
    });

    // Stats bar
    if !spec.stats.is_empty() {
        let mut stats_body = String::new();
        for (num, label) in spec.stats {
            let _ = writeln!(stats_body, "**{num}** {label}");
        }
        sections.push(GeneratedSection {
            heading: "Stats".to_string(),
            body: stats_body,
            citation_refs: Vec::new(),
        });
    }

    // Features
    for pack in spec.features {
        let icon_name = suggest_icon_for(&pack.section_title);
        let mut body = String::new();
        let _ = writeln!(body, "{{{{icon:lucide:{icon_name} size=28}}}}\n");
        if let Some(first) = pack.chunks.first() {
            let excerpt = first_two_sentences(&first.content);
            let _ = writeln!(body, "{excerpt}");
        } else {
            body.push_str("Feature description goes here.\n");
        }
        sections.push(GeneratedSection {
            heading: pack.section_title.clone(),
            body,
            citation_refs: Vec::new(),
        });
    }

    Ok(GeneratedContent {
        title: spec.title.to_string(),
        artifact_type: ArtifactType::LandingPage,
        sections,
    })
}

/// Heuristic: map a section title to a sensible default Lucide icon.
/// Used only as an authoring hint; the user can change the icon later in
/// the editor.
fn suggest_icon_for(title: &str) -> &'static str {
    let t = title.to_lowercase();
    if t.contains("growth") || t.contains("trend") {
        "trending-up"
    } else if t.contains("decline") || t.contains("loss") {
        "trending-down"
    } else if t.contains("stat") || t.contains("metric") || t.contains("kpi") {
        "bar-chart-3"
    } else if t.contains("team") || t.contains("people") || t.contains("user") {
        "users"
    } else if t.contains("process") || t.contains("flow") || t.contains("step") {
        "list-checks"
    } else if t.contains("compare") || t.contains("vs") {
        "git-compare"
    } else if t.contains("security") || t.contains("privacy") {
        "shield-check"
    } else if t.contains("global") || t.contains("world") || t.contains("region") {
        "globe-2"
    } else if t.contains("speed") || t.contains("fast") || t.contains("perf") {
        "rocket"
    } else if t.contains("idea") || t.contains("innovation") {
        "lightbulb"
    } else {
        "sparkles"
    }
}

/// Find the first numeric stat in the top chunk that looks like a
/// percentage (`87%`), a count (`12,345`), a multiplier (`3x`), or a
/// monetary value (`$1.2M`). Returns `(number_string, label_after)`.
fn extract_stat(chunks: &[crate::generator::SourceChunk]) -> Option<(String, String)> {
    let first = chunks.first()?;
    // Match patterns like "87%", "$1.2M", "3x", "12,345" followed by a
    // 1-5 word label. Intentionally non-extended to keep character-class
    // semantics predictable across regex versions.
    let re =
        regex::Regex::new(r"\b(\$?\d+(?:[,\d]*)?(?:\.\d+)?[MKB]?%?x?)\s+([A-Za-z][\w \-/]{2,40})")
            .ok()?;
    let m = re.captures(&first.content)?;
    let num = m.get(1)?.as_str().to_string();
    let label = m.get(2)?.as_str().trim().to_string();
    Some((num, label))
}

fn first_two_sentences(text: &str) -> String {
    let mut out = String::new();
    let mut sentences = 0;
    for c in text.chars() {
        out.push(c);
        if c == '.' || c == '!' || c == '?' {
            sentences += 1;
            if sentences >= 2 {
                break;
            }
        }
        if out.len() >= 300 {
            break;
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::SourceChunk;

    fn pack(title: &str, content: &str) -> SourcePack {
        SourcePack {
            section_title: title.to_string(),
            prompt: String::new(),
            chunks: vec![SourceChunk {
                content: content.to_string(),
                source_path: format!("{}.md", title.to_lowercase()),
                relevance: 0.9,
            }],
        }
    }

    #[test]
    fn infographic_includes_layout_and_icons() {
        let packs = vec![
            pack(
                "Growth Trends",
                "We grew 87% YoY. Revenue exceeded expectations by a healthy margin.",
            ),
            pack(
                "Team",
                "Our team doubled to 12 engineers across three offices.",
            ),
        ];
        let spec = InfographicSpec {
            title: "Q3 2025 Highlights",
            subtitle: Some("A quick look at where we are."),
            layout: InfographicLayout::Grid,
            color_scheme: InfographicColorScheme {
                primary: Some("#7C3AED".to_string()),
                ..Default::default()
            },
            default_icon_set: None,
            source_packs: &packs,
        };
        let out = generate_infographic(&spec).unwrap();
        assert_eq!(out.artifact_type, ArtifactType::Infographic);
        let md = out.to_markdown();
        assert!(md.contains("kind: infographic"));
        assert!(md.contains("layout: grid"));
        assert!(md.contains("primary: \"#7C3AED\""));
        // Each section has an icon token.
        assert!(md.contains("{{icon:lucide:trending-up"));
        assert!(md.contains("{{icon:lucide:users"));
    }

    #[test]
    fn infographic_extracts_stat_into_bold_line() {
        let packs = vec![pack(
            "Adoption",
            "Within the first quarter, 92% of customers enabled the new feature. Engagement also climbed.",
        )];
        let spec = InfographicSpec {
            title: "Adoption",
            subtitle: None,
            layout: InfographicLayout::Vertical,
            color_scheme: InfographicColorScheme::default(),
            default_icon_set: None,
            source_packs: &packs,
        };
        let out = generate_infographic(&spec).unwrap();
        let md = out.to_markdown();
        assert!(
            md.contains("**92%** of customers"),
            "expected stat extraction: got {md}"
        );
    }

    #[test]
    fn landing_page_has_hero_features_stats() {
        let features = vec![
            pack(
                "Fast Search",
                "Sub-millisecond lookups powered by a tantivy index.",
            ),
            pack("Privacy First", "Your data never leaves your machine."),
        ];
        let stats = vec![
            ("1.4M".to_string(), "documents indexed".to_string()),
            ("99.99%".to_string(), "uptime".to_string()),
        ];
        let spec = LandingPageSpec {
            title: "Tessera",
            hero_headline: "Your knowledge, your machine",
            hero_subheadline: "Local-first AI knowledge substrate",
            hero_cta: Some("Download"),
            features: &features,
            stats: &stats,
        };
        let out = generate_landing_page(&spec).unwrap();
        assert_eq!(out.artifact_type, ArtifactType::LandingPage);
        let md = out.to_markdown();
        assert!(md.contains("kind: landing_page"));
        assert!(md.contains("# Your knowledge, your machine"));
        assert!(md.contains("[Download](#cta)"));
        assert!(md.contains("**1.4M** documents indexed"));
        assert!(md.contains("**99.99%** uptime"));
        assert!(md.contains("Fast Search"));
        assert!(md.contains("Privacy First"));
        assert!(md.contains("{{icon:lucide:"));
    }

    #[test]
    fn empty_source_pack_still_produces_section() {
        let packs = vec![SourcePack {
            section_title: "Empty".to_string(),
            prompt: String::new(),
            chunks: Vec::new(),
        }];
        let spec = InfographicSpec {
            title: "Empty Spec",
            subtitle: None,
            layout: InfographicLayout::Vertical,
            color_scheme: InfographicColorScheme::default(),
            default_icon_set: None,
            source_packs: &packs,
        };
        let out = generate_infographic(&spec).unwrap();
        let md = out.to_markdown();
        assert!(md.contains("Add a source for this section"));
    }

    #[test]
    fn suggest_icon_uses_keyword_heuristics() {
        assert_eq!(suggest_icon_for("Team Growth"), "trending-up");
        assert_eq!(suggest_icon_for("Decline in errors"), "trending-down");
        assert_eq!(suggest_icon_for("Security & Privacy"), "shield-check");
        assert_eq!(suggest_icon_for("KPI Dashboard"), "bar-chart-3");
        assert_eq!(suggest_icon_for("Random Header"), "sparkles");
    }
}
