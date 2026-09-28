# OmniMesh

Distributed control plane for AnvilAI generation jobs, sketched in
[`../Omnimesh.md`](../Omnimesh.md). This directory holds the first real
implementation slice: `llm_generation` jobs only, no dashboard-adjacent
infra (Proxmox/Unraid agents, incidents) yet.

## Layout

```
control-plane/      Decides who does work - never runs generation itself.
  hub/               Node/Express API + Postgres. Job queue, node
                     registry, WebSocket push.
  dashboard/         React/Vite/Tailwind/Zustand UI - node matrix, job
                     stream, per-node config/metrics detail panel.

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
cd control-plane/hub
cp .env.example .env   # set a real AGENT_TOKEN
docker compose up -d --build
```

Starts Postgres (migrations auto-applied) and the hub API on
`localhost:4000`. REST + WebSocket (`/ws`) on the same port.

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
