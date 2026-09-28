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

`hammer_code` (multi-pass generate-test-refine loop) plus an OpenAI-compatible
HTTP wrapper around it.

## Running

```
docker compose up --build
```

This starts two containers:

- `llama-server` — the llama.cpp HTTP API on `localhost:8080`. Place a GGUF
  model in `models/` and set `MODEL_FILE` in `.env` (see `.env.example`) to
  match.
- `hammer-api` — an OpenAI-compatible wrapper on `localhost:8001` that runs
  requests through the hammer loop (see below).

## API

`POST /v1/chat/completions`, OpenAI chat-completions shaped request/response.

To run the hammer loop (generate, test, refine), include a fenced
` ```test ` block in the last user message with the test/assertion code to
verify the generated code against. Everything outside that block is the task
description:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Write a function `add(a, b)` that returns the sum.\n\n```test\nassert add(2, 3) == 5\n```"
    }
  ]
}
```

The response is standard OpenAI shape (`choices[0].message.content`), plus a
non-standard `hammer: {passed, passes_used}` field. If no ` ```test ` block is
present, the request is passed straight through to `llama-server` as a single
call (no hammer loop) — a plain OpenAI client works as-is.

Iteration ceiling defaults to `HAMMER_PASSES` (env, default `5`); override
per-request with an optional `"passes"` field in the body.

## Tuning hammer iterations

Every pass of the hammer loop (from the API or from calling `hammer_code`
directly) is logged as one JSON line per pass to `logs/<request_id>.jsonl`:
prompt, model response, extracted code, test output, and pass/fail. Use these
logs to see how many passes tasks actually need (e.g. `jq .passed
logs/*.jsonl` or aggregate `pass` numbers of first-success) before adjusting
`HAMMER_PASSES`.

## CLI / library use

`hammer_code(task, test_code, passes=5, client=None, verbose=False,
on_pass=None)` in `src/hammer.py` can be called directly. `verbose=True`
prints each pass to stdout; `on_pass` takes a callback (used by the API to
write the JSONL logs) for programmatic use.
