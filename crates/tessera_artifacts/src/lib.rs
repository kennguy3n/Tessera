//! Artifact model and the generation, storage, task, automation, and
//! comparison logic built on top of it.
#![warn(missing_docs)]

/// The `artifact` module.
pub mod artifact;
pub mod automations;
/// The `comparison` module.
pub mod comparison;
/// The `extraction` module.
pub mod extraction;
/// The `generator` module.
pub mod generator;
/// The `manager` module.
pub mod manager;
/// The `store` module.
pub mod store;
pub mod tasks;
pub mod visual;

pub use artifact::Artifact;
pub use automations::{Automation, AutomationAction, AutomationStore, AutomationTrigger};
pub use comparison::{compare_sources, ComparisonResult};
pub use extraction::{extract_tasks_decisions, ExtractedItem, ItemType};
pub use generator::{generate_draft_from_sources, GeneratedContent, SourceChunk, SourcePack};
pub use manager::ArtifactManager;
pub use tasks::{Task, TaskStore, TaskUpdate};
pub use visual::{
    generate_infographic, generate_landing_page, InfographicColorScheme, InfographicLayout,
    InfographicSpec, LandingPageSpec,
};
