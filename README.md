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

This repo is now split along a control-plane/client line (see
`omnimesh/README.md`). Everything below - the actual generation engine -
is client/worker software; it's what a node runs, whether or not that
node is also wired into the OmniMesh hub.

```
omnimesh/client/docker/                Dockerfile(s) for the llama.cpp server build
omnimesh/client/models/                GGUF model files (gitignored, mount or download at runtime)
omnimesh/client/engine/                Orchestration layer (hammer loop, API wrapper, sandboxing)
omnimesh/client/scripts/entrypoint.sh  Container entrypoint for llama-server
omnimesh/client/scripts/install.sh     Standalone Linux installer - no Docker (see below)
omnimesh/client/scripts/install.ps1    Standalone Windows installer - no Docker (see below)
scripts/build_website.py               Standalone website-builder test tool (see below) - not
                                        node/worker software, stays at repo root
omnimesh/                              Distributed control plane (hub + dashboard) and the
                                        worker agent that talks to it - see omnimesh/README.md
Omnimesh.md                            Design doc for the distributed job mesh
```

## Status

`hammer_code` / `hammer_html` (multi-pass generate-test-refine loops) plus an
OpenAI-compatible HTTP wrapper, a standalone website-builder tool, and a
Docker-free Linux installer. `Omnimesh.md` sketches a future control plane
for distributing jobs across multiple nodes; nothing in that doc is built
yet — everything below runs on a single machine.

## Running

Two ways to run this, same containers/services either way:

### Docker (development)

```
cd omnimesh/client
docker compose up --build
```

This starts two containers:

- `llama-server` — the llama.cpp HTTP API on `localhost:8080`. Place a GGUF
  model in `omnimesh/client/models/` and set `MODEL_FILE` in `.env` (see
  `omnimesh/client/.env.example`) to match.
- `hammer-api` — an OpenAI-compatible wrapper on `localhost:8001` that runs
  requests through the hammer loop (see below).

### Standalone installer (no Docker)

```
curl -sSL https://raw.githubusercontent.com/Nvmdfth/AnvilAI/main/omnimesh/client/scripts/install.sh | sudo bash
```

Detects an NVIDIA or Vulkan-capable GPU and uses it if present, otherwise
falls back to CPU. Downloads a prebuilt `llama-server` binary (no source
compile), the default model, and installs both `llama-server` and
`hammer-api` as system-level `systemd` services under `/opt/anvilai`,
running as `nobody` — survives reboot and logout, no active session needed.
Same ports (`8080`/`8001`) and same API as the Docker path. CUDA/Vulkan
backend paths are confirmed working on both Linux and Windows (GPU-
verified). `omnimesh/client/scripts/install.ps1` is the Windows
equivalent (`irm .../omnimesh/client/scripts/install.ps1 | iex`), using
Scheduled Tasks instead of systemd for persistence.

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

## How a pass works

Every pass sends a single, self-contained prompt — task, full test code, and
(from pass 2 on) the previous attempt's code and error — rather than an
accumulating chat history. Small models tend to just re-emit a prior answer
verbatim if it's sitting in history as an assistant turn, so each retry is
built fresh from `task` + `test_code` instead.

If a retry reproduces the *exact same code* as a previous pass ("stuck"),
`hammer_code` bumps the sampling temperature (starts at `0.2`, +`0.4` per
stuck pass, capped at `1.2`) and adds an explicit callout naming the specific
failing assertion, telling the model not to repeat its approach. This is what
actually unblocks a model that's converged on a wrong-but-confident answer —
plain retries with identical prompts just reproduce the same bug.

## Tuning hammer iterations

Every pass (from the API or from calling `hammer_code` directly) is logged as
one JSON line to `logs/<request_id>.jsonl`: `pass`, `temperature`, `repeat`
(whether this pass's code matched a prior pass), `prompt`, `response`,
`code`, `test_output`, `passed`.

Useful queries once you have real traffic in `logs/`:

```bash
# pass at which each request first succeeded (or 0 if it never did)
jq -s '[.[] | select(.passed)][0].pass // 0' logs/*.jsonl

# how often a pass just reproduces the previous attempt (wasted budget)
jq '.repeat' logs/*.jsonl | sort | uniq -c
```

If most requests succeed on pass 1–2, `HAMMER_PASSES` is oversized for that
workload. If failures cluster with `"repeat": true` on the final passes, the
task/tests are ambiguous or beyond the model's ability — more passes won't
help; a bigger/less-quantized model or clearer tests will. Confirmed by
testing: a 1.5B q4 model correctly resolves a "stuck" failure once told which
exact assertion it keeps failing, but a subset of edge-case bugs (e.g. empty
input handling) need that explicit callout, not just more passes.

## Standalone website builder

`scripts/build_website.py` runs the same generate/verify/retry pattern as
`hammer_code`, but for a single-file HTML page instead of a Python function.
It talks directly to `llama-server` — not through `hammer-api` — and writes
the result straight to a directory:

```bash
python3 scripts/build_website.py "<task description>" <checks_file> <output_dir>
```

`<checks_file>` is a `.py` file of assertions checked against a string
variable named `html`, e.g.:

```python
assert '<h1>' in html
assert 'Contact' in html
```

Verification is HTML well-formedness (matched opening/closing tags) plus
those assertions. Output lands at `<output_dir>/index.html`; passes are
logged to `logs/` the same way `hammer_code` passes are, so the same `jq`
queries above work on website-build logs too. Runs to completion and exits
— no server, no Claude Code involvement needed once it's kicked off.

## CLI / library use

`hammer_code(task, test_code, passes=5, client=None, verbose=False,
on_pass=None)` in `omnimesh/client/engine/hammer.py` can be called directly. `verbose=True`
prints each pass to stdout; `on_pass` takes a callback (used by the API to
write the JSONL logs) for programmatic use.
