pub mod artifact;
pub mod comparison;
pub mod extraction;
pub mod generator;
pub mod manager;
pub mod store;
pub mod visual;

pub use artifact::Artifact;
pub use comparison::{compare_sources, ComparisonResult};
pub use extraction::{extract_tasks_decisions, ExtractedItem, ItemType};
pub use generator::{generate_draft_from_sources, GeneratedContent, SourceChunk, SourcePack};
pub use manager::ArtifactManager;
pub use visual::{
    generate_infographic, generate_landing_page, InfographicColorScheme, InfographicLayout,
    InfographicSpec, LandingPageSpec,
};
