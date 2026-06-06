//! Append-only audit event model, logger, and storage.
#![warn(missing_docs)]

pub mod event;
pub mod logger;
pub mod store;

pub use event::{AuditEvent, AuditEventType};
pub use logger::AuditLogger;
