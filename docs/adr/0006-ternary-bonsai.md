# 6. Ternary-Bonsai as the default local model

## Status

Accepted.

## Context

A local-first app ([ADR-0004](0004-local-first.md)) generates artifact
drafts and runs inference tasks (importance tagging, entity extraction,
summary generation, concept synthesis) on the user's own hardware. The
default model therefore has to be small enough to run on commodity
laptops and quantized aggressively, while staying good enough for
Tessera's structured-generation tasks. Relying on a hosted LLM by
default would break the local-first and privacy guarantees.

## Decision

Ship **Ternary-Bonsai** as the default local text model. Ternary-Bonsai
is a ternary-quantized (≈2-bit) member of the Bonsai model family,
distributed in MLX (`Q1_0_g128` / 2-bit) and GGUF forms and repacked via
the PrismML llama.cpp fork. The known variants and their download
descriptors are defined in `crates/tessera_runtime/src/config.rs` (e.g.
`ternary-bonsai-1.7b-mlx`, source `kennguy3n/Ternary-Bonsai-1.7B-MLX`).

The runtime selects an adapter by capability and platform with a fixed
fallback priority (`crates/tessera_runtime/src/adapters.rs`):

```
MLXAdapter → LlamaCppAdapter → ExternalAdapter → Fallback (extraction-only)
```

On Apple Silicon the MLX 2-bit build is preferred; elsewhere the GGUF
build runs through the llama.cpp adapter. The external-provider adapter
is opt-in and only reached when both local adapters are unavailable
([ADR-0004](0004-local-first.md)). If no model is available at all,
Tessera degrades to an extraction-only mode rather than failing.

## Consequences

- Text generation works fully offline on modest hardware, preserving the
  privacy and local-first guarantees.
- Ternary quantization keeps the download and memory footprint small
  enough to bundle/download per device tier, at some cost to raw model
  quality versus larger hosted models — mitigated by grammar-constrained
  decoding and the opt-in external provider for users who want it.
- The runtime must carry multiple model formats (MLX vs GGUF) and the
  PrismML llama.cpp fork, and keep the model registry in
  `config.rs` accurate.
- Device tiering and the adapter fallback chain become core runtime
  concerns, since the same default model has to behave across a wide
  hardware range.
