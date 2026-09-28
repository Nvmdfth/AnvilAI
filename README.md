# AnvilAI

Self-hosted, multi-node infrastructure for running small LLMs iteratively
and effectively across whatever hardware you actually have — a GPU box, a
CPU-bound mini PC, a Raspberry Pi — pooled into one mesh.

The name comes from the generation approach: repeated, cheap passes over a
small model (the hammer) rather than one expensive pass on a big one. The
distributed piece that pools multiple machines together, queues work, and
routes it to whichever node is ready, is called **OmniMesh** — see
[`Omnimesh.md`](Omnimesh.md) for the original design sketch and
[`omnimesh/README.md`](omnimesh/README.md) for the implementation reference.

## What's actually in this repo

Two halves, split at `omnimesh/`:

- **Control plane** (`omnimesh/control-plane/`) — decides who does work.
  Never runs generation itself. A Node/Express hub (job queue, node
  registry, WebSocket push, Postgres) plus a React dashboard.
- **Client** (`omnimesh/client/`) — runs on every worker node and actually
  does the work. A Rust agent that registers with the hub, benchmarks the
  node, and proxies jobs to a local `hammer-api` instance, which in turn
  drives `llama-server` (llama.cpp) through the generate/test/refine loop.

You can also run just the client half standalone, single-machine, no mesh
at all — point an OpenAI client straight at a node's `hammer-api` and skip
the hub entirely. The mesh is additive, not required.

## Install: the control plane (server)

One machine runs this — wherever you want the hub + dashboard living.

```bash
cd omnimesh/control-plane
cp .env.example .env   # set a real AGENT_TOKEN - this doubles as the
                        # OpenAI-client API key later
docker compose up -d --build
```

This starts three containers: Postgres (migrations auto-applied), the hub
API on `:4000` (REST + WebSocket `/ws` on the same port), and the
dashboard on `:5173` (static build served via nginx, proxying `/api` and
`/ws` to the hub). Open `http://<server>:5173` for the dashboard.

No GPU, no llama.cpp, nothing generation-related runs here — this is pure
orchestration.

## Install: a client (worker node)

Every machine you want doing actual generation work needs **two** pieces
running together: the generation engine (`llama-server` + `hammer-api`),
and the agent that reports it to the hub. The agent alone has nothing to
execute jobs with; the engine alone never talks to the hub — the agent is
the bridge.

### 1. The generation engine

**Docker (any OS with Docker):**

```bash
cd omnimesh/client
cp .env.example .env   # set MODEL_FILE if not using the default
docker compose up -d --build
```

Place a GGUF model in `omnimesh/client/models/` first (or let the
installer below fetch the default one for you). Starts `llama-server` on
`:8080` and `hammer-api` on `:8001`.

**No Docker - Linux:**

```bash
curl -sSL https://raw.githubusercontent.com/Nvmdfth/AnvilAI/main/omnimesh/client/scripts/install.sh | sudo bash
```

Detects an NVIDIA or Vulkan-capable GPU and uses it if present, otherwise
falls back to CPU. Downloads a prebuilt `llama-server` binary (no source
compile), the default model, and installs both `llama-server` and
`hammer-api` as system-level `systemd` services under `/opt/anvilai`,
running as `nobody` — survives reboot and logout.

**No Docker - Windows (PowerShell, no admin required):**

```powershell
irm https://raw.githubusercontent.com/Nvmdfth/AnvilAI/main/omnimesh/client/scripts/install.ps1 | iex
```

Same GPU detection (NVIDIA/Vulkan/CPU, CUDA-verified working), same
default model, installed under `%LOCALAPPDATA%\AnvilAI` and registered as
logon-triggered Scheduled Tasks instead of systemd.

### 2. The agent

Points the engine above at the hub. Needs `HUB_URL` and `AGENT_TOKEN`
(matching the control plane's) set before it'll do anything useful.

**Linux:**

```bash
cd omnimesh/client/agent
sudo ./install.sh
```

Builds a release binary (needs a Rust toolchain — `rustup.rs`
recommended) and installs it as a systemd service. Edit
`/etc/omnimesh-agent.env` (`HUB_URL`, `AGENT_TOKEN`, `NODE_NAME`), then:

```bash
sudo systemctl start omnimesh-agent
journalctl -u omnimesh-agent -f
```

**Windows:**

```powershell
cd omnimesh\client\agent
cargo build --release
$env:HUB_URL = "http://<hub-host>:4000"
$env:AGENT_TOKEN = "<matches the hub's AGENT_TOKEN>"
.\target\release\omnimesh-agent.exe
```

No installer/service wrapper for the agent on Windows yet — run it
manually (or wrap it in your own Scheduled Task) for now. This is the one
real gap in the Windows path; `install.ps1` above only handles the engine.

Until the local `hammer-api` reports healthy, the agent registers with the
hub as `status: "installing"` rather than `"online"`, so the hub won't
route jobs to it mid-setup.

GPU detection (NVIDIA/AMD/Intel, via `nvidia-smi`/WMI on Windows) is
automatic and reported to the hub in `hardware_metadata.gpus` — nothing to
configure.

## Using it

### Through the mesh (recommended)

```
POST http://<hub>:4000/v1/chat/completions
Authorization: Bearer <AGENT_TOKEN>
```

Standard OpenAI chat-completions request/response — point VS Code or any
other OpenAI-compatible client straight at `http://<hub>:4000/v1` with the
hub's `AGENT_TOKEN` as the API key. The hub creates a job, waits for
whichever node picks it up to finish, and relays the (already
OpenAI-shaped) result back. Queuing, node selection, and reporting are all
invisible from the client's side.

`stream: true` is faked as a single SSE chunk rather than rejected — the
hammer loop only has an answer after several full generate/verify passes,
so there's nothing to stream token-by-token, but clients that always
request streaming won't break on a plain JSON body either. Default wait
before a `504` is 10 minutes (`CHAT_JOB_TIMEOUT_MS` env on the hub); the
job itself isn't lost on timeout, it can still finish and show up via
`GET /jobs/:id`.

To run the hammer loop (generate, test, refine) instead of a single plain
pass, include a fenced ` ```test ` block in the last user message with
the assertion code to verify the generated code against — everything
outside that block is the task description:

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

The response includes a non-standard `hammer: {passed, passes_used}`
field alongside the standard `choices[0].message.content`. No test block
present → passed straight through as a single call, no hammer loop.

### Direct to one node (no mesh)

Same `POST /v1/chat/completions` shape, but hit a node's `hammer-api`
directly (`http://<node>:8001`, or `:8011` if that port's taken locally)
instead of the hub. No auth, no queuing, no benchmarking — just that one
machine.

### Dashboard

`http://<server>:5173` — node matrix (status, GPUs, live CPU/mem/
benchmark), job stream, per-node config (hammer passes, priority),
submit-a-job form.

## How a hammer pass works

Every pass sends a single, self-contained prompt — task, full test code,
and (from pass 2 on) the previous attempt's code and error — rather than
an accumulating chat history. Small models tend to just re-emit a prior
answer verbatim if it's sitting in history as an assistant turn, so each
retry is built fresh from `task` + `test_code` instead.

If a retry reproduces the *exact same code* as a previous pass ("stuck"),
`hammer_code` bumps the sampling temperature (starts at `0.2`, +`0.4` per
stuck pass, capped at `1.2`) and adds an explicit callout naming the
specific failing assertion, telling the model not to repeat its approach.
This is what actually unblocks a model that's converged on a
wrong-but-confident answer — plain retries with identical prompts just
reproduce the same bug.

Iteration ceiling defaults to `HAMMER_PASSES` (env, default `5`); override
per-request with an optional `"passes"` field in the body, or per-node
from the dashboard's node-detail panel.

## Tuning hammer iterations

Every pass is logged as one JSON line to `logs/<request_id>.jsonl`:
`pass`, `temperature`, `repeat` (whether this pass's code matched a prior
pass), `prompt`, `response`, `code`, `test_output`, `passed`.

```bash
# pass at which each request first succeeded (or 0 if it never did)
jq -s '[.[] | select(.passed)][0].pass // 0' logs/*.jsonl

# how often a pass just reproduces the previous attempt (wasted budget)
jq '.repeat' logs/*.jsonl | sort | uniq -c
```

If most requests succeed on pass 1–2, `HAMMER_PASSES` is oversized for
that workload. If failures cluster with `"repeat": true` on the final
passes, the task/tests are ambiguous or beyond the model's ability — more
passes won't help; a bigger/less-quantized model or clearer tests will.
Confirmed by testing: a 1.5B q4 model correctly resolves a "stuck" failure
once told which exact assertion it keeps failing, but a subset of
edge-case bugs (e.g. empty input handling) need that explicit callout, not
just more passes.

## Standalone website builder

`scripts/build_website.py` runs the same generate/verify/retry pattern as
`hammer_code`, but for a single-file HTML page instead of a Python
function. It talks directly to `llama-server` — not through `hammer-api`,
not through the mesh — and writes the result straight to a directory:

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
logged to `logs/` the same way `hammer_code` passes are.

## CLI / library use

`hammer_code(task, test_code, passes=5, client=None, verbose=False,
on_pass=None)` in `omnimesh/client/engine/hammer.py` can be called
directly. `verbose=True` prints each pass to stdout; `on_pass` takes a
callback (used by the API to write the JSONL logs) for programmatic use.

## Repo layout

```
omnimesh/control-plane/   Hub (Node/Express + Postgres) + dashboard (React).
                           Orchestration only - never runs generation.
omnimesh/client/           Agent (Rust) + engine (hammer-api, llama-server
                           Dockerfiles, installers). Runs on every worker.
Omnimesh.md                 Original distributed-mesh design doc.
scripts/build_website.py    Standalone tool, unrelated to the mesh.
```

See [`omnimesh/README.md`](omnimesh/README.md) for the full implementation
reference (dev workflows, manual testing without installing anything,
what each service's env vars do).
