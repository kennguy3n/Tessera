use std::path::Path;

pub struct IgnoreRules {
    patterns: Vec<IgnorePattern>,
}

#[derive(Debug)]
enum IgnorePattern {
    Exact(String),
    Extension(String),
    Prefix(String),
    Contains(String),
}

impl IgnoreRules {
    pub fn new(patterns: &[String]) -> Self {
        let parsed = patterns
            .iter()
            .map(|p| {
                if let Some(ext) = p.strip_prefix("*.") {
                    IgnorePattern::Extension(ext.to_lowercase())
                } else if let Some(prefix) = p.strip_suffix('*') {
                    IgnorePattern::Prefix(prefix.to_string())
                } else if p.contains('*') {
                    let inner = p.replace('*', "");
                    IgnorePattern::Contains(inner)
                } else {
                    IgnorePattern::Exact(p.clone())
                }
            })
            .collect();
        Self { patterns: parsed }
    }

    pub fn default_rules() -> Self {
        Self::new(&default_patterns())
    }

    pub fn is_ignored(&self, path: &Path) -> bool {
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();

        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_lowercase();

        for component in path.components() {
            let comp_str = component.as_os_str().to_str().unwrap_or_default();
            for pattern in &self.patterns {
                if let IgnorePattern::Exact(exact) = pattern {
                    if comp_str == exact {
                        return true;
                    }
                }
            }
        }

        for pattern in &self.patterns {
            match pattern {
                IgnorePattern::Exact(exact) => {
                    if file_name == exact {
                        return true;
                    }
                }
                IgnorePattern::Extension(ext) => {
                    if extension == *ext {
                        return true;
                    }
                }
                IgnorePattern::Prefix(prefix) => {
                    if file_name.starts_with(prefix.as_str()) {
                        return true;
                    }
                }
                IgnorePattern::Contains(inner) => {
                    if file_name.contains(inner.as_str()) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

fn default_patterns() -> Vec<String> {
    vec![
        ".git",
        "node_modules",
        ".DS_Store",
        "Thumbs.db",
        "Desktop.ini",
        "*.exe",
        "*.dll",
        "*.so",
        "*.dylib",
        "*.bin",
        "*.o",
        "*.a",
        "*.lib",
        "*.obj",
        "*.class",
        "*.pyc",
        "*.pyo",
        "target",
        "dist",
        "__pycache__",
        ".svn",
        ".hg",
        "*.zip",
        "*.tar",
        "*.gz",
        "*.bz2",
        "*.7z",
        "*.rar",
        "*.iso",
        "*.dmg",
        "*.img",
        "*.mp3",
        "*.mp4",
        "*.avi",
        "*.mov",
        "*.wav",
        "*.flac",
        "*.woff",
        "*.woff2",
        "*.ttf",
        "*.otf",
        "*.eot",
        "*.ico",
        "*.icns",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn ignores_git_directory() {
        let rules = IgnoreRules::default_rules();
        assert!(rules.is_ignored(Path::new(".git")));
        assert!(rules.is_ignored(Path::new("repo/.git/config")));
    }

    #[test]
    fn ignores_node_modules() {
        let rules = IgnoreRules::default_rules();
        assert!(rules.is_ignored(Path::new("node_modules")));
        assert!(rules.is_ignored(Path::new("project/node_modules/pkg/index.js")));
    }

    #[test]
    fn ignores_binary_extensions() {
        let rules = IgnoreRules::default_rules();
        assert!(rules.is_ignored(Path::new("program.exe")));
        assert!(rules.is_ignored(Path::new("lib.dll")));
        assert!(rules.is_ignored(Path::new("lib.so")));
    }

    #[test]
    fn allows_supported_files() {
        let rules = IgnoreRules::default_rules();
        assert!(!rules.is_ignored(Path::new("README.md")));
        assert!(!rules.is_ignored(Path::new("document.pdf")));
        assert!(!rules.is_ignored(Path::new("data.csv")));
        assert!(!rules.is_ignored(Path::new("notes.txt")));
        assert!(!rules.is_ignored(Path::new("page.html")));
    }

    #[test]
    fn custom_patterns() {
        let rules = IgnoreRules::new(&["*.log".to_string(), "temp".to_string()]);
        assert!(rules.is_ignored(Path::new("app.log")));
        assert!(rules.is_ignored(Path::new("temp")));
        assert!(!rules.is_ignored(Path::new("data.csv")));
    }

    #[test]
    fn ignores_ds_store() {
        let rules = IgnoreRules::default_rules();
        assert!(rules.is_ignored(&PathBuf::from(".DS_Store")));
    }
}
