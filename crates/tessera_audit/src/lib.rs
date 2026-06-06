//! Append-only audit event model, logger, and storage.
#![warn(missing_docs)]

/// The `event` module.
pub mod event;
/// The `logger` module.
pub mod logger;
/// The `store` module.
pub mod store;

pub use event::{AuditEvent, AuditEventType};
pub use logger::AuditLogger;
