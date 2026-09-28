# OmniMesh

Distributed control plane for AnvilAI generation jobs, sketched in
[`../Omnimesh.md`](../Omnimesh.md). This directory holds the first real
implementation slice: `llm_generation` jobs only, no dashboard-adjacent
infra (Proxmox/Unraid agents, incidents) yet.

## Layout

```
control-plane/      Decides who does work - never runs generation itself.
  docker-compose.yml Runs all three below together: Postgres, hub, dashboard.
  hub/               Node/Express API + Postgres. Job queue, node
                     registry, WebSocket push.
  dashboard/         React/Vite/Tailwind/Zustand UI - node matrix, job
                     stream, per-node config/metrics detail panel.
                     Dockerfile builds a static bundle served via nginx,
                     which proxies /api and /ws to the hub container.

client/              Runs on a worker node and actually does the work.
  agent/             Rust worker agent. Registers with the hub,
                     benchmarks itself, polls for jobs, proxies them to
                     a local hammer-api instance (below).
  engine/            hammer-api: the generate/test/refine loop and its
                     OpenAI-compatible HTTP wrapper (formerly repo-root
                     `src/`).
  docker/            Dockerfile(s) for llama-server + hammer-api.
  scripts/           install.sh/.ps1 (Docker-free installers) and
                     entrypoint.sh (container entrypoint).
  docker-compose.yml, requirements.txt, .env.example, models/
```

## Running the control plane

```
cd control-plane
cp .env.example .env   # set a real AGENT_TOKEN
docker compose up -d --build
```

Starts Postgres (migrations auto-applied), the hub API on `localhost:4000`
(REST + WebSocket `/ws` on the same port), and the dashboard on
`localhost:5173` (a static build served via nginx, which proxies `/api`
and `/ws` to the hub container - see `dashboard/nginx.conf`).

### OpenAI-compatible interface

`POST /v1/chat/completions` on the hub takes a standard OpenAI chat
request (`model`, `messages[]`, optional `stream`) and does the queuing
for you: it creates a job, blocks until some node reports a result, and
relays that result back - already OpenAI-shaped, since that's what
hammer-api itself returns. Point any OpenAI-compatible client (VS Code
extensions included) at `http://<hub>:4000/v1`, API key = `AGENT_TOKEN`.

`stream: true` doesn't stream incrementally - the hammer loop only has
an answer after several full generate/verify passes, so there's nothing
to stream token-by-token. It's faked as a single SSE chunk instead, so
clients that always request streaming don't break. Default wait is 10
minutes (`CHAT_JOB_TIMEOUT_MS` env) before a `504`; the job itself isn't
lost, it can still finish and show up via `GET /jobs/:id`.

### Dashboard dev server (hot reload, no Docker)

```
cd control-plane/dashboard
npm install
npm run dev
```

Dev server on `localhost:5173`, proxies `/api` and `/ws` to the hub on
`:4000` (see `vite.config.ts` if the hub runs elsewhere).

## Running a worker node

A node needs `hammer-api` running locally (Docker or the standalone
installer, both under `client/`) *and* the agent that talks to the hub
on its behalf.

```
cd client
docker compose up -d --build   # llama-server + hammer-api
```

or, without Docker:

```
cd client/scripts && sudo ./install.sh   # Linux
cd client/scripts && .\install.ps1       # Windows
```

Then the agent itself:

```
cd client/agent
sudo ./install.sh   # Linux: builds a release binary, installs as a
                     # systemd service. Edit /etc/omnimesh-agent.env
                     # (HUB_URL, AGENT_TOKEN matching the hub's,
                     # NODE_NAME) before starting it, then:
                     #   sudo systemctl start omnimesh-agent
                     #   journalctl -u omnimesh-agent -f
```

Needs a Rust toolchain (`rustup.rs` recommended - the Debian-packaged
`rustc` on a Pi has been too old for current dependency versions in
this session; see `client/scripts/install.sh`'s commit for the same
issue on the hammer-api/llama-server side).

### Windows

`cargo build --release` in `client/agent/` on a Windows machine with
Rust installed produces a working `.exe` - the agent's dependencies
(`reqwest`, `tokio`, `sysinfo`) are all cross-platform, and it now
detects NVIDIA/AMD/Intel GPUs via `nvidia-smi`/WMI and reports them in
`hardware_metadata.gpus`.

`client/scripts/install.ps1` is the Windows equivalent of
`client/scripts/install.sh`: it detects a GPU backend and downloads a
matching llama.cpp build (CUDA/Vulkan/CPU), the default model, and sets
up hammer-api's venv, then registers both as logon-triggered Scheduled
Tasks (no admin rights needed - unlike a Windows service). Nothing
starts the `omnimesh-agent.exe` itself yet on Windows, unlike the
Linux agent's own `client/agent/install.sh`; run it manually for now
with `HUB_URL`/`AGENT_TOKEN`/etc. set.

Until hammer-api reports healthy, the agent registers with the hub as
`status: "installing"` rather than `"online"`, so the hub won't assign
it jobs mid-setup - see `main.rs`'s readiness gate.

## Manual/dev testing without installing anything

```
# hub, without Docker for the server process itself:
cd control-plane/hub && npm install && npx tsx src/server.ts

# agent, one-off:
cd client/agent && cargo run -- # reads HUB_URL / AGENT_TOKEN / etc. from env
```
