//! ONNX-backed semantic embedding provider.
//!
//! Bridges the trait surface defined in [`crate::embedding`] to an
//! `ort::Session` running a sentence-transformer style model
//! (MiniLM / XLM-R distillates). Used by the bridge layer when the
//! user opts in to the "Semantic" embedding tier in Settings; the
//! offline default is [`crate::embedding::HashTrickEmbedding`].
//!
//! ## Trait shape vs. session ownership
//!
//! The [`crate::embedding::EmbeddingProvider`] trait is `Send +
//! Sync` and exposes `embed(&self, _)`. `ort::Session::run` takes
//! `&mut self`, so we wrap the session in a [`Mutex`] for interior
//! mutability. Single-text `embed` calls are short (<100 ms on
//! CPU for a 128-token batch on either shipped model) so the
//! mutex contention is negligible in practice; the indexing path
//! amortises this by calling `embed_batch` which runs one ONNX
//! inference per 32-text batch instead of one per text.
//!
//! ## Why mean-pool + L2-normalise
//!
//! Sentence-transformer models output one vector per input token
//! (shape `[batch, seq_len, hidden_dim]`). The published checkpoints
//! were trained with **mean pooling** of those token vectors,
//! masked by the attention mask, followed by L2 normalisation —
//! reproducing that post-processing is what makes the cosine
//! similarities meaningful. Skipping either step (using the raw
//! `[CLS]` vector, or omitting L2) materially hurts retrieval
//! quality. We never use the model's `pooler_output` head even
//! when present, because it was trained for next-sentence
//! prediction, not for semantic similarity.
//!
//! ## Sequence length
//!
//! We truncate every input to 128 tokens. This is the sweet spot
//! the underlying models were trained at: retrieval quality
//! plateaus past 128 tokens on the canonical STS / BEIR
//! benchmarks, and longer inputs both slow inference quadratically
//! (attention is O(N²)) and bias the pooled vector toward
//! whatever filler text dominates the tail of a long chunk. The
//! chunker that produces our input text already targets
//! 256-character chunks (~64 BPE tokens for English), so 128
//! tokens is a comfortable upper bound that only triggers on
//! deliberately long chunks.

use std::path::Path;
use std::sync::Mutex;

use ndarray::Array2;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use tessera_core::error::{Error, Result};
use tokenizers::{Tokenizer, TruncationDirection, TruncationParams, TruncationStrategy};

use crate::embedding::EmbeddingProvider;

/// Maximum sequence length (in tokens) the embedder feeds into the
/// model. Inputs longer than this are truncated by the tokenizer
/// before being passed to ONNX. See module docs for the rationale.
pub const MAX_SEQUENCE_LENGTH: usize = 128;

/// Batch size for [`OnnxEmbeddingProvider::embed_batch`]. The indexing
/// path will chop a larger input list into batches of this size
/// before calling `embed_batch` once per batch. 32 is a balance
/// between: (a) amortising the per-call ONNX overhead (a few ms
/// each) and (b) keeping the working-set memory bounded so a
/// background indexing pass doesn't crowd the foreground LLM.
pub const BATCH_SIZE: usize = 32;

/// ONNX-backed embedding provider for sentence-transformer models.
///
/// Construct one via [`OnnxEmbeddingProvider::load`]; the session
/// owns the model weights for the lifetime of the provider. The
/// bridge layer wraps the provider in `Arc<dyn EmbeddingProvider>`
/// and swaps the active provider when the user changes the
/// embedding tier from Settings — the [`crate::embedding::
/// EmbeddingProvider::model_id`] contract guarantees that
/// previously-cached vectors tagged with the old `model_id` are
/// ignored at search time, so the swap is safe even before the
/// background re-embed pass has caught up.
pub struct OnnxEmbeddingProvider {
    /// `Mutex<Session>` because `ort::Session::run` takes `&mut
    /// self` and the trait method `embed(&self, _)` only has shared
    /// access. See module docs on contention.
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    /// Stable identifier for this loaded model — written into the
    /// `chunk_embeddings.model_id` column so hybrid search can
    /// filter to the current model's vectors. Format is
    /// `onnx:{slug}:{dim}d` to keep it self-describing in logs.
    model_id: String,
    /// Output vector dimensionality. Always 384 for the two
    /// shipped models, but stored per-instance so a future
    /// 768-dim model can register and load without code changes.
    dim: usize,
}

impl OnnxEmbeddingProvider {
    /// Load an ONNX model + its HuggingFace tokenizer.
    ///
    /// `slug` is the registry slug (e.g. `"all-MiniLM-L6-v2"`).
    /// `dim` is the expected output dimensionality; it MUST match
    /// the registry entry so the bridge can sanity-check on load.
    /// A mismatch between the registry's declared `dim` and the
    /// model's actual output shape would silently produce wrong-
    /// dimension vectors and corrupt the `chunk_embeddings` table.
    ///
    /// The session is built with `Level3` graph optimisation —
    /// the highest tier ONNX Runtime offers — because the cost
    /// is one-time at load (a few hundred ms) and the steady-
    /// state inference cost dominates the benefit. We also pin
    /// intra-op threads to a small number (capped at 4) so a
    /// background re-embed pass cannot starve the foreground
    /// LLM token generator. The cap matches the posture
    /// `tessera_runtime` takes for the vision sidecar.
    pub fn load(model_path: &Path, tokenizer_path: &Path, slug: &str, dim: usize) -> Result<Self> {
        let session = Session::builder()
            .map_err(onnx_err)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(onnx_err)?
            // Bound to min(num_cpus, 4). Sentence-transformer
            // inference is memory-bandwidth bound; pushing past
            // 4 threads gives diminishing returns and slows
            // foreground generation under load.
            .with_intra_threads(std::cmp::min(num_cpus(), 4))
            .map_err(onnx_err)?
            .commit_from_file(model_path)
            .map_err(onnx_err)?;

        let mut tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| Error::InvalidConfig(format!("failed to load tokenizer: {e}")))?;

        // Configure truncation on the tokenizer itself rather than
        // capping `for j in 0..max_len` in `embed_batch_inner`. The
        // difference matters because BERT / XLM-R post-processors
        // add the trailing `[SEP]` / `</s>` token AFTER the content
        // tokens, so naively slicing at `MAX_SEQUENCE_LENGTH` would
        // drop the trailing special token on inputs that exceed the
        // cap. Letting `Tokenizer::with_truncation` truncate the
        // CONTENT tokens (LongestFirst, from the right) and then
        // letting the post-processor re-add the special tokens
        // preserves both `[CLS]` and `[SEP]` — matching the reference
        // sentence-transformers Python implementation
        // (`AutoTokenizer.from_pretrained(..., model_max_length=128)`
        // or `tokenizer.enable_truncation(max_length=128)` in the
        // tokenizers Python bindings). In practice the chunker
        // already targets ~256 chars / ~64 BPE tokens so most inputs
        // do not trigger truncation at all, but we want the rare
        // long-input case to also produce sentence-transformers-
        // identical embeddings rather than embeddings missing the
        // trailing delimiter.
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_SEQUENCE_LENGTH,
                strategy: TruncationStrategy::LongestFirst,
                stride: 0,
                direction: TruncationDirection::Right,
            }))
            .map_err(|e| {
                Error::InvalidConfig(format!("failed to set tokenizer truncation: {e}"))
            })?;

        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
            model_id: format!("onnx:{slug}:{dim}d"),
            dim,
        })
    }

    /// Batch-embed a slice of texts in groups of [`BATCH_SIZE`].
    ///
    /// Returns vectors in the same order as the input slice. Each
    /// vector is L2-normalised so a downstream cosine similarity
    /// reduces to a dot product. Empty input strings produce a
    /// zero vector (length [`Self::dim`]) without invoking the
    /// model — the tokenizer can't produce meaningful input_ids
    /// from an empty string and the resulting normalised vector
    /// would be undefined.
    ///
    /// Batching is on the text axis, not the token axis: within
    /// one batch we pad every text to the longest sequence in
    /// that batch (capped at [`MAX_SEQUENCE_LENGTH`]). This
    /// avoids over-padding short batches and keeps cross-batch
    /// determinism intact: the result for text `i` does not
    /// depend on which other texts share its batch.
    pub fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        let mut out = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(BATCH_SIZE) {
            // Split empty inputs out — the model can't sensibly
            // embed an empty string. We still preserve order by
            // collecting indices.
            let mut nonempty_texts: Vec<&str> = Vec::with_capacity(chunk.len());
            let mut nonempty_positions: Vec<usize> = Vec::with_capacity(chunk.len());
            for (i, text) in chunk.iter().enumerate() {
                if text.is_empty() {
                    continue;
                }
                nonempty_texts.push(text);
                nonempty_positions.push(i);
            }

            let mut batch_results: Vec<Option<Vec<f32>>> = (0..chunk.len()).map(|_| None).collect();

            if !nonempty_texts.is_empty() {
                let embeddings = self.embed_batch_inner(&nonempty_texts)?;
                for (pos, vec) in nonempty_positions.into_iter().zip(embeddings) {
                    batch_results[pos] = Some(vec);
                }
            }

            for slot in batch_results {
                match slot {
                    Some(v) => out.push(v),
                    None => out.push(vec![0.0; self.dim]),
                }
            }
        }
        Ok(out)
    }

    /// Inner batch embed that assumes all inputs are non-empty.
    /// Splitting this out keeps [`embed_batch`]'s empty-string
    /// preservation logic readable; this function is the actual
    /// tokenize → ONNX → pool → normalise pipeline.
    fn embed_batch_inner(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        // Encode the batch. `encode_batch` with `true` for
        // add_special_tokens is required so the tokenizer adds the
        // model's [CLS] / [SEP] (or <s> / </s> for XLM-R) markers
        // — without these the model's positional embeddings are
        // misaligned and similarity quality collapses.
        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| Error::InvalidConfig(format!("tokenizer encode_batch failed: {e}")))?;

        let batch = encodings.len();
        // Pad to the longest sequence in THIS batch. The tokenizer is
        // already configured with `TruncationParams { max_length:
        // MAX_SEQUENCE_LENGTH }` in `load()`, so every encoding here
        // is guaranteed to be `<= MAX_SEQUENCE_LENGTH` AND has its
        // trailing `[SEP]` / `</s>` special token intact (truncation
        // happens before the post-processor re-adds those, matching
        // sentence-transformers' reference Python behaviour). The
        // `.min(MAX_SEQUENCE_LENGTH)` cap below is therefore a
        // defence-in-depth no-op: it stays as a backstop against a
        // future tokenizer.json that ships with a higher pre-baked
        // truncation, but it must NOT be relied on for correctness
        // because slicing here would re-introduce the dropped-SEP
        // bug the tokenizer-level truncation was added to fix.
        let max_len = encodings
            .iter()
            .map(|e| e.get_ids().len())
            .max()
            .unwrap_or(0)
            .min(MAX_SEQUENCE_LENGTH);

        // Two flat buffers for ndarray::Array2 construction. We
        // build them column-major-friendly (one row per text) so
        // the `Array2::from_shape_vec((batch, max_len), ...)` call
        // below is a no-copy reshape.
        let mut input_ids: Vec<i64> = Vec::with_capacity(batch * max_len);
        let mut attention_mask: Vec<i64> = Vec::with_capacity(batch * max_len);
        // `token_type_ids` is required by BERT-style models (e.g.
        // all-MiniLM, which uses BERT WordPiece) but absent from
        // XLM-R models (e.g. paraphrase-multilingual). We compute
        // it for every batch and skip feeding it to the session
        // below when the model doesn't have an `token_type_ids`
        // input — the ONNX runtime would reject the extra input
        // otherwise.
        let mut token_type_ids: Vec<i64> = Vec::with_capacity(batch * max_len);

        for enc in &encodings {
            let ids = enc.get_ids();
            let mask = enc.get_attention_mask();
            let type_ids = enc.get_type_ids();
            for j in 0..max_len {
                if j < ids.len() {
                    input_ids.push(i64::from(ids[j]));
                    attention_mask.push(i64::from(mask[j]));
                    // `type_ids` may be shorter than `ids` for
                    // some tokenizers; default to 0 (the BERT
                    // "first segment" id) when missing.
                    token_type_ids.push(type_ids.get(j).copied().map_or(0, i64::from));
                } else {
                    input_ids.push(0);
                    attention_mask.push(0);
                    token_type_ids.push(0);
                }
            }
        }

        let shape = (batch, max_len);
        let ids_array = Array2::from_shape_vec(shape, input_ids)
            .map_err(|e| Error::InvalidConfig(format!("input_ids reshape: {e}")))?;
        let mask_array = Array2::from_shape_vec(shape, attention_mask.clone())
            .map_err(|e| Error::InvalidConfig(format!("attention_mask reshape: {e}")))?;
        let type_ids_array = Array2::from_shape_vec(shape, token_type_ids)
            .map_err(|e| Error::InvalidConfig(format!("token_type_ids reshape: {e}")))?;

        // Build the input value map. We always include
        // `token_type_ids` in the candidate inputs and then
        // filter by what the loaded session actually expects;
        // this is cheaper than re-allocating two different input
        // maps per architecture.
        let ids_tensor = Tensor::from_array(ids_array).map_err(onnx_err)?;
        let mask_tensor = Tensor::from_array(mask_array).map_err(onnx_err)?;
        let type_ids_tensor = Tensor::from_array(type_ids_array).map_err(onnx_err)?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| Error::InvalidConfig("ONNX session mutex poisoned".to_string()))?;

        // Snapshot the metadata we need BEFORE calling `run`. The
        // returned `SessionOutputs` borrows `&self` of the session
        // until it is dropped, which would conflict with re-reading
        // `session.outputs` afterwards. Cloning the names up front
        // also keeps the `outputs[...]` indexing below `'static`
        // ergonomic without juggling lifetimes.
        let has_token_type_ids = session.inputs.iter().any(|i| i.name == "token_type_ids");
        let first_output_name = session
            .outputs
            .first()
            .ok_or_else(|| {
                Error::InvalidConfig("ONNX model has no outputs; cannot embed".to_string())
            })?
            .name
            .clone();

        let outputs = if has_token_type_ids {
            session
                .run(ort::inputs![
                    "input_ids" => ids_tensor,
                    "attention_mask" => mask_tensor,
                    "token_type_ids" => type_ids_tensor,
                ])
                .map_err(onnx_err)?
        } else {
            session
                .run(ort::inputs![
                    "input_ids" => ids_tensor,
                    "attention_mask" => mask_tensor,
                ])
                .map_err(onnx_err)?
        };

        // Mean-pool + normalise. We accept either `last_hidden_state`
        // (the standard sentence-transformer output) or the first
        // output if the model uses a different name — some Xenova
        // ONNX exports rename the output to `sentence_embedding`
        // or just `0` depending on the export script version.
        let pooled_name: &str = if outputs.contains_key("last_hidden_state") {
            "last_hidden_state"
        } else if outputs.contains_key("token_embeddings") {
            "token_embeddings"
        } else {
            // Fall back to the first output (name snapshot above).
            first_output_name.as_str()
        };

        let (shape_view, data) = outputs[pooled_name]
            .try_extract_tensor::<f32>()
            .map_err(onnx_err)?;

        // Expected shape: [batch, seq_len, hidden_dim]. We do not
        // accept anything else — if a future model emits a 2D
        // pooled output instead, the call site should switch to
        // that output explicitly rather than silently mean-pool a
        // batch of pre-pooled vectors.
        // `Shape` derefs to `&[i64]`; index via `&shape_view[..]`
        // because `[T]::as_slice` was only stabilised in Rust
        // 1.84 and the workspace MSRV is below that.
        let dims: &[i64] = &shape_view[..];
        if dims.len() != 3 {
            return Err(Error::InvalidConfig(format!(
                "expected 3D output [batch, seq, hidden], got {:?}",
                dims
            )));
        }
        let (out_batch, out_seq, hidden) = (dims[0] as usize, dims[1] as usize, dims[2] as usize);
        if out_batch != batch {
            return Err(Error::InvalidConfig(format!(
                "ONNX output batch dim {out_batch} != input batch dim {batch}"
            )));
        }
        if hidden != self.dim {
            return Err(Error::InvalidConfig(format!(
                "ONNX output hidden dim {hidden} != configured dim {}",
                self.dim
            )));
        }
        // BERT-family and XLM-R models always emit one hidden state per input
        // token, so out_seq must equal the input sequence length we padded to
        // (max_len). Both currently-shipped models satisfy this invariant; we
        // assert it here as defence-in-depth so a future encoder with a
        // different output stride (e.g. one that strips CLS/EOS, or one that
        // pools internally) fails loudly rather than silently misindexing the
        // attention_mask vs the pooled-token tensor below.
        if out_seq != max_len {
            return Err(Error::InvalidConfig(format!(
                "ONNX output seq dim {out_seq} != input seq dim {max_len}; \
                 attention_mask stride would mismatch the pooled-tensor stride"
            )));
        }

        // Mean-pool over the seq axis, weighted by attention_mask.
        // We then L2-normalise per-batch-row. Vectorised over the
        // hidden dimension; `dim` is 384 in production so this
        // tight loop is well-predicted by the compiler.
        let mut result = Vec::with_capacity(batch);
        for b in 0..batch {
            let mut pooled = vec![0.0_f32; hidden];
            let mut mask_sum: f32 = 0.0;
            for s in 0..out_seq {
                let mask = attention_mask[b * max_len + s];
                if mask == 0 {
                    continue;
                }
                mask_sum += 1.0;
                let token_offset = (b * out_seq + s) * hidden;
                for h in 0..hidden {
                    pooled[h] += data[token_offset + h];
                }
            }
            // mask_sum can be 0 if a text degenerates to only
            // padding (e.g. tokenizer ate everything as
            // unknown-with-attention=0). Treat that as a zero
            // vector rather than dividing by zero.
            if mask_sum > 0.0 {
                let inv = 1.0 / mask_sum;
                for slot in pooled.iter_mut().take(hidden) {
                    *slot *= inv;
                }
            }
            // L2 normalise. After this the cosine similarity of
            // two embeddings equals their dot product, which is
            // what the hybrid search code assumes.
            let norm: f32 = pooled.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 0.0 {
                let inv = 1.0 / norm;
                for slot in pooled.iter_mut().take(hidden) {
                    *slot *= inv;
                }
            }
            result.push(pooled);
        }

        Ok(result)
    }
}

impl EmbeddingProvider for OnnxEmbeddingProvider {
    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn dim(&self) -> usize {
        self.dim
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>> {
        // Single-text embed routes through the batch path so the
        // single-vs-batch results are bit-for-bit identical. This
        // matters for tests that compare `embed("x")` to
        // `embed_batch(&["x"])[0]` and would matter in production
        // if the indexer ever calls `embed` for a one-off chunk
        // while a backfill pass calls `embed_batch` for the bulk.
        let mut out = self.embed_batch(&[text])?;
        out.pop().ok_or_else(|| {
            Error::InvalidConfig(
                "embed_batch returned no vectors for a single-text input".to_string(),
            )
        })
    }
}

/// Convert an [`ort::Error`] into the workspace's `tessera_core::
/// error::Error`. The ONNX errors are usually quite long (they
/// include the ORT call stack); we surface the message verbatim
/// so a maintainer reading the bridge logs has the full context
/// without needing to enable ORT trace logging.
fn onnx_err(err: ort::Error) -> Error {
    Error::InvalidConfig(format!("onnx runtime error: {err}"))
}

/// Best-effort CPU count for `with_intra_threads`. Falls back to 1
/// on platforms where `available_parallelism` returns `Err` (e.g.
/// containerised environments with no /proc/cpuinfo). 1 is safer
/// than a hardcoded large number — better to under-thread and lose
/// some throughput than to over-thread and contend with the LLM.
fn num_cpus() -> usize {
    std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get)
}
