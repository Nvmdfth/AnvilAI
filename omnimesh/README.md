# OmniMesh

Distributed control plane for AnvilAI generation jobs, sketched in
[`../Omnimesh.md`](../Omnimesh.md). This directory holds the first real
implementation slice: `llm_generation` jobs only, no dashboard-adjacent
infra (Proxmox/Unraid agents, incidents) yet.

## Layout

```
hub/        Control plane: Node/Express API + Postgres. Job queue,
            node registry, WebSocket push.
agent/      Rust worker agent. Registers with the hub, benchmarks
            itself, polls for jobs, proxies them to a local AnvilAI
            hammer-api instance.
dashboard/  React/Vite/Tailwind/Zustand UI - node matrix, job stream,
            per-node config/metrics detail panel.
```

## Running the hub

```
cd hub
cp .env.example .env   # set a real AGENT_TOKEN
docker compose up -d --build
```

Starts Postgres (migrations auto-applied) and the hub API on
`localhost:4000`. REST + WebSocket (`/ws`) on the same port.

## Running the dashboard

```
cd dashboard
npm install
npm run dev
```

Dev server on `localhost:5173`, proxies `/api` and `/ws` to the hub on
`:4000` (see `vite.config.ts` if the hub runs elsewhere).

## Installing a worker agent (Linux)

On any machine that already has AnvilAI's `hammer-api` running locally
(see the main repo's `docker-compose.yml` or `scripts/install.sh`):

```
cd agent
sudo ./install.sh
```

Builds a release binary and installs it as a systemd service. Edit
`/etc/omnimesh-agent.env` (`HUB_URL`, `AGENT_TOKEN` matching the hub's,
`NODE_NAME`) before starting it:

```
sudo systemctl start omnimesh-agent
journalctl -u omnimesh-agent -f
```

Needs a Rust toolchain (`rustup.rs` recommended - the Debian-packaged
`rustc` on a Pi has been too old for current dependency versions in
this session; see the main repo's `scripts/install.sh` commit for the
same issue on the AnvilAI side).

### Windows

`cargo build --release` in `agent/` on a Windows machine with Rust
installed produces a working `.exe` - the agent's dependencies
(`reqwest`, `tokio`, `sysinfo`) are all cross-platform, and it now
detects NVIDIA/AMD/Intel GPUs via `nvidia-smi`/WMI and reports them in
`hardware_metadata.gpus`.

The agent still needs a local `hammer-api` to proxy jobs to (as on
Linux). `../../scripts/install.ps1` is the Windows equivalent of the
root `scripts/install.sh`: it detects a GPU backend and downloads a
matching llama.cpp build (CUDA/Vulkan/CPU), the default model, and sets
up hammer-api's venv, then registers both as logon-triggered Scheduled
Tasks (no admin rights needed - unlike a Windows service). Nothing
starts the `omnimesh-agent.exe` itself yet on Windows, unlike the
Linux agent's own `agent/install.sh`; run it manually for now with
`HUB_URL`/`AGENT_TOKEN`/etc. set.

Until hammer-api reports healthy, the agent registers with the hub as
`status: "installing"` rather than `"online"`, so the hub won't assign
it jobs mid-setup - see `main.rs`'s readiness gate.

## Manual/dev testing without installing anything

```
# hub, without Docker for the server process itself:
cd hub && npm install && npx tsx src/server.ts

# agent, one-off:
cd agent && cargo run -- # reads HUB_URL / AGENT_TOKEN / etc. from env
```
