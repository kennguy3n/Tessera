pub mod chunker;
pub mod embedding;
pub mod extractor;
// Phase 19 Task 1: ONNX-backed semantic embedding provider + the
// model registry that supplies its weights. Both live in
// `tessera_sources` because the ONNX session is consumed in-process
// by the indexer and search engine, not by an out-of-process
// sidecar (which is what `tessera_runtime` manages).
pub mod hybrid;
pub mod ignore;
pub mod image_metadata;
pub mod indexer;
pub mod kchat_crypto;
pub mod manager;
pub mod mem;
pub mod model_registry;
pub mod onnx_embedder;
pub mod pdf_extractor;
pub mod progress;
pub mod search;
pub mod source;
pub mod store;
pub mod vision_extractor;
pub mod watcher;
