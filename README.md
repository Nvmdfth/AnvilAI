# AnvilAI

Self-hosted container for running small LLMs iteratively and effectively on
CPU-bound, low-end hardware (Raspberry Pi and similar ARM/x86 boxes).

The name comes from the approach: repeated, cheap passes over a small model
(the hammer) rather than one expensive pass on a big one.

## Goals

- Run quantized GGUF models on CPU via `llama.cpp`, no GPU required.
- Multi-pass / iterative prompting strategies to recover quality that a
  single small-model pass would miss.
- Low memory and thread footprint suitable for Pi-class hardware.

## Layout

```
docker/     Dockerfile(s) for the llama.cpp server build
models/     GGUF model files (gitignored, mount or download at runtime)
src/        Orchestration layer (iterative passes, prompting logic)
scripts/    Helper scripts (model download, entrypoint, etc.)
```

## Status

Early scaffolding. No orchestration logic yet.

## Running

```
docker compose up --build
```

The `llama-server` container exposes the llama.cpp HTTP API on
`localhost:8080`. Place a GGUF model in `models/` and set `MODEL_FILE` in
`.env` (see `.env.example`) to match.
