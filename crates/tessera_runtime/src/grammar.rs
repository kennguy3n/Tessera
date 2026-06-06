//! Constrained-decoding grammars selected per artifact type.

use tessera_core::ArtifactType;

/// Returns the GBNF grammar that constrains generation to the
/// JSON schema for the given artifact type.
pub fn load_grammar(artifact_type: ArtifactType) -> String {
    match artifact_type {
        ArtifactType::Document => DOCUMENT_GRAMMAR.to_string(),
        ArtifactType::Slides => SLIDES_GRAMMAR.to_string(),
        ArtifactType::Sheet => SHEET_GRAMMAR.to_string(),
        ArtifactType::Base => BASE_GRAMMAR.to_string(),
        ArtifactType::Infographic => INFOGRAPHIC_GRAMMAR.to_string(),
        ArtifactType::LandingPage => LANDING_PAGE_GRAMMAR.to_string(),
    }
}

const DOCUMENT_GRAMMAR: &str = r#"
root ::= "{" ws "\"sections\"" ws ":" ws sections ws "}"
sections ::= "[" ws section (ws "," ws section)* ws "]"
section ::= "{" ws "\"title\"" ws ":" ws string ws "," ws "\"content\"" ws ":" ws string ws ("," ws "\"citations\"" ws ":" ws citations ws)? "}"
citations ::= "[" ws (string (ws "," ws string)*)? ws "]"
string ::= "\"" ([^"\\] | "\\" .)* "\""
ws ::= [ \t\n\r]*
"#;

const SLIDES_GRAMMAR: &str = r#"
root ::= "{" ws "\"slides\"" ws ":" ws slides ws "}"
slides ::= "[" ws slide (ws "," ws slide)* ws "]"
slide ::= "{" ws "\"title\"" ws ":" ws string ws "," ws "\"bullets\"" ws ":" ws bullets ws ("," ws "\"notes\"" ws ":" ws string ws)? "}"
bullets ::= "[" ws (string (ws "," ws string)*)? ws "]"
string ::= "\"" ([^"\\] | "\\" .)* "\""
ws ::= [ \t\n\r]*
"#;

const SHEET_GRAMMAR: &str = r#"
root ::= "{" ws "\"columns\"" ws ":" ws columns ws "," ws "\"rows\"" ws ":" ws rows ws "}"
columns ::= "[" ws (string (ws "," ws string)*)? ws "]"
rows ::= "[" ws (row (ws "," ws row)*)? ws "]"
row ::= "[" ws (string (ws "," ws string)*)? ws "]"
string ::= "\"" ([^"\\] | "\\" .)* "\""
ws ::= [ \t\n\r]*
"#;

const BASE_GRAMMAR: &str = r#"
root ::= "{" ws "\"fields\"" ws ":" ws fields ws "," ws "\"records\"" ws ":" ws records ws "}"
fields ::= "[" ws (field (ws "," ws field)*)? ws "]"
field ::= "{" ws "\"name\"" ws ":" ws string ws "," ws "\"type\"" ws ":" ws fieldtype ws "}"
fieldtype ::= "\"text\"" | "\"number\"" | "\"date\"" | "\"select\"" | "\"checkbox\"" | "\"url\""
records ::= "[" ws (record (ws "," ws record)*)? ws "]"
record ::= "{" ws (kv (ws "," ws kv)*)? ws "}"
kv ::= string ws ":" ws value
value ::= string | number | "true" | "false" | "null"
number ::= "-"? [0-9]+ ("." [0-9]+)?
string ::= "\"" ([^"\\] | "\\" .)* "\""
ws ::= [ \t\n\r]*
"#;

const INFOGRAPHIC_GRAMMAR: &str = r#"
root ::= "{" ws "\"title\"" ws ":" ws string ws "," ws "\"layout\"" ws ":" ws layout ws "," ws "\"sections\"" ws ":" ws sections ws "}"
layout ::= "\"vertical\"" | "\"horizontal\"" | "\"grid\""
sections ::= "[" ws section (ws "," ws section)* ws "]"
section ::= "{" ws "\"heading\"" ws ":" ws string ws "," ws "\"body\"" ws ":" ws string ws ("," ws "\"icon\"" ws ":" ws string ws)? ("," ws "\"stat\"" ws ":" ws string ws)? "}"
string ::= "\"" ([^"\\] | "\\" .)* "\""
ws ::= [ \t\n\r]*
"#;

const LANDING_PAGE_GRAMMAR: &str = r#"
root ::= "{" ws "\"title\"" ws ":" ws string ws "," ws "\"hero\"" ws ":" ws hero ws "," ws "\"features\"" ws ":" ws features ws ("," ws "\"stats\"" ws ":" ws stats ws)? "}"
hero ::= "{" ws "\"headline\"" ws ":" ws string ws "," ws "\"subheadline\"" ws ":" ws string ws ("," ws "\"cta\"" ws ":" ws string ws)? "}"
features ::= "[" ws feature (ws "," ws feature)* ws "]"
feature ::= "{" ws "\"title\"" ws ":" ws string ws "," ws "\"description\"" ws ":" ws string ws ("," ws "\"icon\"" ws ":" ws string ws)? "}"
stats ::= "[" ws stat (ws "," ws stat)* ws "]"
stat ::= "{" ws "\"value\"" ws ":" ws string ws "," ws "\"label\"" ws ":" ws string ws "}"
string ::= "\"" ([^"\\] | "\\" .)* "\""
ws ::= [ \t\n\r]*
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_grammar_not_empty() {
        let g = load_grammar(ArtifactType::Document);
        assert!(g.contains("root"));
        assert!(g.contains("sections"));
        assert!(g.contains("string"));
    }

    #[test]
    fn slides_grammar_has_bullets() {
        let g = load_grammar(ArtifactType::Slides);
        assert!(g.contains("slides"));
        assert!(g.contains("bullets"));
        assert!(g.contains("notes"));
    }

    #[test]
    fn sheet_grammar_has_columns_and_rows() {
        let g = load_grammar(ArtifactType::Sheet);
        assert!(g.contains("columns"));
        assert!(g.contains("rows"));
    }

    #[test]
    fn base_grammar_has_fields_and_records() {
        let g = load_grammar(ArtifactType::Base);
        assert!(g.contains("fields"));
        assert!(g.contains("records"));
        assert!(g.contains("fieldtype"));
    }

    #[test]
    fn infographic_grammar_has_sections_and_layout() {
        let g = load_grammar(ArtifactType::Infographic);
        assert!(g.contains("layout"));
        assert!(g.contains("sections"));
        assert!(g.contains("heading"));
    }

    #[test]
    fn landing_page_grammar_has_hero_and_features() {
        let g = load_grammar(ArtifactType::LandingPage);
        assert!(g.contains("hero"));
        assert!(g.contains("features"));
        assert!(g.contains("headline"));
    }

    #[test]
    fn all_grammars_valid_structure() {
        for artifact_type in [
            ArtifactType::Document,
            ArtifactType::Slides,
            ArtifactType::Sheet,
            ArtifactType::Base,
            ArtifactType::Infographic,
            ArtifactType::LandingPage,
        ] {
            let g = load_grammar(artifact_type);
            assert!(
                g.contains("root ::="),
                "Grammar for {artifact_type:?} missing root rule"
            );
            assert!(
                g.contains("string ::="),
                "Grammar for {artifact_type:?} missing string rule"
            );
            assert!(
                g.contains("ws ::="),
                "Grammar for {artifact_type:?} missing ws rule"
            );
        }
    }
}
