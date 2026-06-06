//! Citation tracking and storage plus source-freshness checks.
#![warn(missing_docs)]

/// The `citation` module.
pub mod citation;
pub mod freshness;
/// The `store` module.
pub mod store;
/// The `tracker` module.
pub mod tracker;

pub use citation::Citation;
pub use freshness::{check_source_freshness, FreshnessStatus};
pub use store::CitationStore;
pub use tracker::{CitationReplacement, CitationTracker};
