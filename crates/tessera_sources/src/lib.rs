//! Source ingestion, extraction, chunking, embedding, and hybrid
//! (lexical + vector) search over the local knowledge substrate.
#![warn(missing_docs)]

pub mod chunker;
pub mod embedding;
pub mod extractor;
// ONNX-backed semantic embedding provider + the
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
// in-memory IVF-Flat ANN index for hybrid
// vector search. Built per-model on first query and cached on
// `SourceStore::vector_index_cache`; invalidated by the
// embedding-generation counter that the store bumps on every
// write that could change `load_embeddings_for_model` output.
pub mod vector_index;
pub mod vision_extractor;
pub mod watcher;
