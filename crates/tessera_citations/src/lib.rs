//! Citation tracking and storage plus source-freshness checks.
#![warn(missing_docs)]

pub mod citation;
pub mod freshness;
pub mod store;
pub mod tracker;

pub use citation::Citation;
pub use freshness::{check_source_freshness, FreshnessStatus};
pub use store::CitationStore;
pub use tracker::{CitationReplacement, CitationTracker};
