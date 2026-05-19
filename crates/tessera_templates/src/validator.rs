use tessera_core::error::{Error, Result};

use crate::template::Template;

pub fn validate_template(template: &Template) -> Result<()> {
    if template.id.is_empty() {
        return Err(Error::TemplateValidation(
            "template id is required".to_string(),
        ));
    }

    if template.name.is_empty() {
        return Err(Error::TemplateValidation(
            "template name is required".to_string(),
        ));
    }

    if template.description.is_empty() {
        return Err(Error::TemplateValidation(
            "template description is required".to_string(),
        ));
    }

    if template.sections.is_empty() {
        return Err(Error::TemplateValidation(
            "template must have at least one section".to_string(),
        ));
    }

    for (i, section) in template.sections.iter().enumerate() {
        if section.title.is_empty() {
            return Err(Error::TemplateValidation(format!(
                "section {i} title is required"
            )));
        }
        if section.prompt.is_empty() {
            return Err(Error::TemplateValidation(format!(
                "section {i} prompt is required"
            )));
        }
    }

    if template.export.is_empty() {
        return Err(Error::TemplateValidation(
            "template must have at least one export format".to_string(),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_template;

    #[test]
    fn valid_template_passes() {
        let yaml = r#"
id: test-v1
name: Test
type: document
description: A test
sections:
  - title: Intro
    prompt: Write intro.
export:
  - markdown
"#;
        let template = parse_template(yaml).unwrap();
        assert!(validate_template(&template).is_ok());
    }

    #[test]
    fn missing_id_fails() {
        let yaml = r#"
id: ""
name: Test
type: document
description: A test
sections:
  - title: Intro
    prompt: Write intro.
export:
  - markdown
"#;
        let template = parse_template(yaml).unwrap();
        assert!(validate_template(&template).is_err());
    }

    #[test]
    fn missing_sections_fails() {
        let yaml = r#"
id: test-v1
name: Test
type: document
description: A test
sections: []
export:
  - markdown
"#;
        let template = parse_template(yaml).unwrap();
        assert!(validate_template(&template).is_err());
    }

    #[test]
    fn missing_export_fails() {
        let yaml = r#"
id: test-v1
name: Test
type: document
description: A test
sections:
  - title: Intro
    prompt: Write intro.
export: []
"#;
        let template = parse_template(yaml).unwrap();
        assert!(validate_template(&template).is_err());
    }

    #[test]
    fn empty_section_title_fails() {
        let yaml = r#"
id: test-v1
name: Test
type: document
description: A test
sections:
  - title: ""
    prompt: Write intro.
export:
  - markdown
"#;
        let template = parse_template(yaml).unwrap();
        assert!(validate_template(&template).is_err());
    }
}
