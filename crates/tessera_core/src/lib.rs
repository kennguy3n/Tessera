//! Core types, configuration, error handling, and the SQLCipher-backed
//! database layer shared across all Tessera crates.
#![warn(missing_docs)]

pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
#[cfg(feature = "pqc")]
pub mod pqc;
pub mod types;

pub use config::TesseraConfig;
pub use db::{
    default_read_pool_size, empty_read_pool, open_shared, open_shared_in_memory,
    open_shared_read_pool, open_shared_read_pool_with_key, open_shared_with_key,
    with_secure_delete, with_secure_delete_transaction, SharedConnection, SharedReadPool,
    DB_KEY_HEX_LEN, MAX_READ_POOL_SIZE,
};
pub use error::{Error, Result};
pub use types::*;
