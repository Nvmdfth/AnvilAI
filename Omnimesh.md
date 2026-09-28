# OmniMesh: Unified Homelab Control Plane & Distributed Job Mesh (v3)

## 1. Executive Summary & Architecture Overview

OmniMesh is a single control plane for a heterogeneous homelab — a Dell
PowerEdge running Proxmox, an Unraid NAS, and a growing set of Raspberry Pi
edge nodes — that handles two kinds of work through one job model instead of
two separate systems:

1. **Infra remediation** — diagnosing and fixing anomalies on Proxmox/Unraid
   hosts via cloud-powered headless CLIs (Claude Code, Antigravity CLI),
   gated behind human approval.
2. **Distributed LLM generation** — dispatching AnvilAI (`hammer_code` /
   `hammer_html`) jobs to whichever node is actually best equipped to run
   them locally, based on measured throughput rather than assumed specs.

Both are just "jobs" from the hub's point of view: something gets queued,
matched to a capable and available node, executed there, and the result
comes back. What differs is the job's `job_type` and what a node needs to
advertise to be eligible for it — the queue, scheduler, dashboard, and
auth model are shared.

```
                  +-----------------------------------+
                  |      OmniMesh Central Hub         |
                  |  (React Dashboard + Job Dispatcher)|
                  +-----------------+-----------------+
                                    | (HTTPS + per-node bearer token)
         +--------------------------+-----------+--------------------------+
         |                          |           |                          |
         v                          v           v                          v
+------------------+       +------------------+ |               +------------------+
|   Proxmox Node   |       |  Unraid Server   | |               | Pi (AnvilAI node)|
| (Dell PowerEdge) |       |  (Storage & Apps)| |               |  * llama-server  |
|  * Proxmox API   |       |  * Docker Socket | |               |  * hammer-api    |
|  * VM/LXC Control|       |  * NAS Pool Stats| |               |  * Rust agent    |
+------------------+       +------------------+ |               |    (proxies jobs |
                                                 |                |    to hammer-api)|
                                     +------------------+         +------------------+
                                     | Pi (edge sensor) |
                                     |  * GPIO / MQTT   |
                                     |  * network probe |
                                     +------------------+
```

A node's role is determined by what it advertises at registration, not by
hardcoded node types — a Pi can be an edge sensor, an AnvilAI worker, or
both. See §5 for capability advertisement.

## 2. The Job Model

The core abstraction is a generic job queue, not an incident queue.
`incidents` (infra anomalies) and `generation_requests` (AnvilAI work) are
both *sources* that enqueue a `jobs` row; the dispatcher only ever looks at
`jobs`.

```sql
-- ==========================================
-- 1. INFRASTRUCTURE NODES
-- ==========================================
CREATE TABLE nodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,                          -- 'dell-proxmox', 'unraid-nas', 'pi-anvil-1'
    host_address VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'offline',                       -- 'online', 'degraded', 'offline'
    capabilities TEXT[] NOT NULL DEFAULT '{}',                  -- e.g. {'proxmox','llm_generation'}
    hardware_metadata JSONB DEFAULT '{}'::jsonb,                -- cores, RAM, ISA flags, OS/agent version
    benchmark_tokens_per_sec NUMERIC(6, 2),                     -- measured, not assumed - see §5
    benchmark_updated_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_nodes_capabilities ON nodes USING GIN (capabilities);

-- ==========================================
-- 2. TELEMETRY & METRICS (Time-Series Data)
-- ==========================================
CREATE TABLE node_telemetry (
    id BIGSERIAL PRIMARY KEY,
    node_id UUID REFERENCES nodes(id) ON DELETE CASCADE,
    cpu_usage_percent NUMERIC(5, 2),
    memory_usage_percent NUMERIC(5, 2),
    disk_usage_percent NUMERIC(5, 2),
    load_average NUMERIC(5, 2)[],
    temperatures JSONB DEFAULT '{}'::jsonb,
    raw_metrics JSONB DEFAULT '{}'::jsonb,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_telemetry_node_recorded ON node_telemetry(node_id, recorded_at DESC);

-- ==========================================
-- 3. GENERIC JOB QUEUE (shared by every job_type)
-- ==========================================
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_type VARCHAR(50) NOT NULL,                              -- 'infra_remediation', 'llm_generation', ...
    required_capability VARCHAR(50) NOT NULL,                   -- must match a node's capabilities entry
    priority SMALLINT DEFAULT 0,                                -- higher = scheduled first
    payload JSONB NOT NULL,                                     -- job_type-specific input
    status VARCHAR(30) DEFAULT 'queued',                        -- 'queued','assigned','running','done','failed'
    assigned_node_id UUID REFERENCES nodes(id) ON DELETE SET NULL,
    result JSONB,                                               -- job_type-specific output
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    assigned_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_jobs_queued ON jobs(status, required_capability, priority DESC) WHERE status = 'queued';

-- ==========================================
-- 4. INCIDENTS (infra_remediation job source)
-- ==========================================
CREATE TABLE incidents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    node_id UUID REFERENCES nodes(id) ON DELETE CASCADE,
    job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,         -- the remediation job this incident enqueued
    severity VARCHAR(20) NOT NULL,                              -- 'info', 'warning', 'critical'
    source_component VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(30) DEFAULT 'detected',                      -- 'detected','pending_approval','resolved','failed'
    detected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE
);

-- ==========================================
-- 5. AI CLI AUDIT LOGS (cost tracking - cloud calls only)
-- ==========================================
-- Local llm_generation jobs incur no API cost and don't need this table;
-- it exists specifically for cloud-CLI-backed remediation.
CREATE TABLE ai_audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
    provider_used VARCHAR(50) NOT NULL,                         -- 'claude_cli', 'antigravity_cli'
    prompt_sent TEXT NOT NULL,
    raw_cli_output TEXT,
    parsed_recommendations JSONB DEFAULT '{}'::jsonb,
    execution_status VARCHAR(30) DEFAULT 'dry_run',             -- 'dry_run','approved','executed','rejected'
    cost_usd NUMERIC(8, 6) DEFAULT 0.000000,
    executed_by VARCHAR(100) DEFAULT 'system_agent',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_job ON ai_audit_logs(job_id);
```

An `llm_generation` job's `payload` looks like:

```json
{
  "task": "Build a one-page site for ...",
  "checks": "assert '<h1>' in html\n...",
  "output": "html",
  "passes": 5
}
```

and its `result` is `{"passed": true, "passes_used": 3, "html": "..."}` —
the same shape `hammer_html` and the `hammer-api` container already
produce. The hub doesn't need to know anything about hammer loops,
temperature escalation, or retries; it just forwards the payload to a node
that advertises `llm_generation` and stores whatever comes back.

## 3. Backend Architecture: Job Dispatcher

The dispatcher's only job is matching `queued` rows in `jobs` to `online`
nodes whose `capabilities` include the job's `required_capability`,
ordered by `benchmark_tokens_per_sec` (for `llm_generation`) or plain
availability (for infra jobs where any capable node will do). Assignment
is a single row update, not a long-lived scheduling process:

```typescript
// dispatcher.ts
async function assignNextJob(jobType: string) {
  const job = await db.oneOrNone(`
    SELECT * FROM jobs
    WHERE status = 'queued' AND job_type = $1
    ORDER BY priority DESC, created_at ASC
    LIMIT 1 FOR UPDATE SKIP LOCKED
  `, [jobType]);
  if (!job) return;

  const node = await db.oneOrNone(`
    SELECT * FROM nodes
    WHERE status = 'online' AND $1 = ANY(capabilities)
    ORDER BY benchmark_tokens_per_sec DESC NULLS LAST
    LIMIT 1
  `, [job.required_capability]);
  if (!node) return; // stays queued until a node is available

  await db.none(`UPDATE jobs SET status = 'assigned', assigned_node_id = $1, assigned_at = now() WHERE id = $2`,
    [node.id, job.id]);
  await sendJobToNode(node, job); // push over the node's open connection, or the node polls and picks it up
}
```

### CLI Execution Wrapper (`aiGateway.ts`) — unchanged from v2, now job-scoped

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface CLIExecutionResult {
  success: boolean;
  rawOutput: string;
  parsedJson?: any;
  error?: string;
  costUsd?: number;
}

export async function invokeAIcli(promptContext: string): Promise<CLIExecutionResult> {
  const binaryPath = process.env.CLAUDE_CLI_PATH || '/usr/local/bin/claude';
  const args = ['-p', promptContext, '--output-format', 'json', '--max-turns', '3'];

  try {
    const { stdout } = await execFileAsync(binaryPath, args, {
      timeout: 45000,
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
    });
    const responseJson = JSON.parse(stdout);
    return { success: true, rawOutput: stdout, parsedJson: responseJson.result || responseJson, costUsd: responseJson.total_cost_usd || 0.0 };
  } catch (error: any) {
    return { success: false, rawOutput: error.stdout || '', error: error.message || 'Unknown CLI execution failure' };
  }
}
```

This wrapper is invoked by the hub itself (it holds the Anthropic API key)
for `infra_remediation` jobs. It is **not** used for `llm_generation` jobs
— those run entirely on the assigned node, which already has its own local
model; the hub never touches an LLM directly for that job type.

## 4. AnvilAI Integration: Nodes as Generation Workers

A node advertises `llm_generation` capability by running the existing,
unmodified AnvilAI stack (`llama-server` + `hammer-api`, both already
containerized) plus a thin Rust agent that:

1. Registers with the hub, advertising `capabilities: ["llm_generation"]`.
2. On registration and periodically thereafter, runs a **fixed reference
   prompt** through its local `hammer-api` and reports the measured
   tok/s as `benchmark_tokens_per_sec`. This is the fix for the problem we
   hit directly on this Pi: static specs (4 cores, 7.6GB RAM) say nothing
   about whether the CPU has the `dotprod`/`i8mm` extensions that
   dominate real throughput. A measured benchmark can't be fooled by specs
   that look better than they perform.
3. When assigned an `llm_generation` job, proxies the payload straight to
   its own `http://localhost:8001/v1/chat/completions` (or the
   `build_website.py`-style path, for HTML jobs) — **no reimplementation
   of the hammer loop in Rust.** The agent is a dispatcher/proxy, not a
   second copy of the generation logic. It streams the JSON result back to
   the hub as the job's `result`.

This means adding a node to the mesh for generation work is: run the
existing `docker compose up` from this repo, plus one Rust binary that
knows the hub's URL and its own bootstrap token. Nothing in `src/hammer.py`,
`src/api.py`, or `scripts/build_website.py` needs to change for this.

## 5. Frontend Dashboard

* **Node Matrix**: health + capabilities + live `benchmark_tokens_per_sec`
  per node (was Proxmox/Unraid/Pi-specific in v2; now capability-driven).
* **Job Stream**: a unified feed — infra remediation cards (with the v2
  "Proposed Action Card" + dry-run approval flow, unchanged) interleaved
  with LLM generation job cards (task, pass/fail, passes used, a preview
  of the generated code/HTML).
* **Submit Job**: a form to enqueue an `llm_generation` job directly
  (task description + checks), for testing generation capacity without
  going through whatever upstream system would normally create these jobs.
* **Human-in-the-Loop Controls**: unchanged from v2 — infra remediation
  still requires explicit approval before execution. `llm_generation` jobs
  need no such gate; they only ever produce code/HTML/text, never execute
  anything on the node.
* **WebSocket State Sync**: unchanged from v2 (Zustand + targeted
  component updates, not full re-renders).

## 6. Node Agent Specifications

* **Proxmox Rust Agent**: unchanged from v2 — Proxmox VE API v2,
  `/cluster/resources` for inventory, QEMU guest agent exec for in-guest
  diagnostics.
* **Unraid Rust Agent**: unchanged from v2 — `bollard` crate against
  `/var/run/docker.sock`, XFS/ZFS pool stats.
* **AnvilAI Worker Agent** (new): thin — job proxy + benchmark runner, as
  described in §4. Advertises `llm_generation`.
* **Raspberry Pi Edge Sensor Agent**: unchanged from v2 — GPIO, temps,
  network reachability. A Pi can run this *and* the AnvilAI worker agent
  side by side; they're independent capabilities on the same node.

## 7. Security Model & Authentication

v2 specified a full zero-trust mTLS gRPC mesh from day one. That's real
ongoing PKI operational cost (issuance, rotation, revocation) for a
handful of home nodes, and `anvil.wanmedia.net` being internet-reachable
doesn't by itself demand it — it demands *some* strong auth, which a
simpler mechanism can provide without the certificate lifecycle:

* **Default: HTTPS + per-node bearer tokens.** Each node gets a
  long-lived token at bootstrap (see §9), sent as `Authorization: Bearer
  <token>` on every call. Tokens are revocable per-node from the dashboard.
  This is the starting point — upgrade to mTLS later if a concrete threat
  model demands it, not before.
* **Docker Socket Privilege Boundary**: unchanged from v2 — mounting
  `/var/run/docker.sock` into the Unraid agent grants root-equivalent
  privilege; that agent container exposes no inbound ports and only calls
  out to the hub.
* **API Key Vaulting**: unchanged from v2 — Anthropic keys live only in
  the hub's environment. `llm_generation` jobs need no cloud credentials
  at all; the node's local model is the only "key."

## 8. Deployment Strategy & Docker Compose

Central hub deployment is unchanged from v2 (Postgres + Node/Express hub +
React dashboard). An AnvilAI-capable node's compose file is simply *this
repo's existing `docker-compose.yml`* (`llama-server` + `hammer-api`) with
one more service added — the Rust agent — pointed at the hub:

```yaml
  omnimesh-agent:
    image: omnimesh-agent:latest
    container_name: omnimesh-agent
    environment:
      HUB_URL: https://anvil.wanmedia.net
      NODE_TOKEN_FILE: /run/secrets/node_token
      LOCAL_HAMMER_API: http://hammer-api:8000
      CAPABILITIES: "llm_generation"
    depends_on:
      - hammer-api
    secrets:
      - node_token
    restart: unless-stopped
```

## 9. Zero-Touch Agent Installation & Bootstrapping

Same one-liner pattern as v2, with one fix: v2 passed `--token` as a CLI
argument, which lands in `ps aux` output and shell history for any local
user to read. The token instead comes in via an environment variable that
the script reads and immediately writes to a 600-permission file, never
logging or re-exposing it:

```bash
#!/bin/bash
set -e

: "${HUB_IP:?HUB_IP env var required}"
: "${BOOTSTRAP_TOKEN:?BOOTSTRAP_TOKEN env var required}"

echo "--> Detecting system architecture..."
ARCH=$(uname -m)
case "$ARCH" in
    x86_64) TARGET="x86_64-unknown-linux-gnu" ;;
    aarch64|arm64) TARGET="aarch64-unknown-linux-gnu" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "--> Downloading OmniMesh Rust Agent for $TARGET..."
AGENT_URL="http://$HUB_IP:4000/downloads/omnimesh-agent-$TARGET"

TOKEN_FILE="/etc/omnimesh/node_token"
mkdir -p /etc/omnimesh
umask 077
printf '%s' "$BOOTSTRAP_TOKEN" > "$TOKEN_FILE"

if [ -f "/etc/unraid-version" ]; then
    echo "--> Unraid environment detected. Setting up persistent flash storage..."
    mkdir -p /boot/custom/omnimesh
    curl -sSL -o /boot/custom/omnimesh/omnimesh-agent "$AGENT_URL"
    chmod +x /boot/custom/omnimesh/omnimesh-agent
    cp /boot/custom/omnimesh/omnimesh-agent /usr/local/bin/omnimesh-agent
    if ! grep -q "omnimesh-agent" /boot/config/go; then
        echo "cp /boot/custom/omnimesh/omnimesh-agent /usr/local/bin/omnimesh-agent" >> /boot/config/go
        echo "nohup /usr/local/bin/omnimesh-agent --hub $HUB_IP --token-file $TOKEN_FILE > /var/log/omnimesh.log 2>&1 &" >> /boot/config/go
    fi
    nohup /usr/local/bin/omnimesh-agent --hub "$HUB_IP" --token-file "$TOKEN_FILE" > /var/log/omnimesh.log 2>&1 &
    echo "--> OmniMesh agent installed and running on Unraid."

elif [ -d "/etc/systemd/system" ]; then
    echo "--> Systemd environment detected (Proxmox/Debian/PiOS)..."
    curl -sSL -o /usr/local/bin/omnimesh-agent "$AGENT_URL"
    chmod +x /usr/local/bin/omnimesh-agent

    cat <<EOF > /etc/systemd/system/omnimesh-agent.service
[Unit]
Description=OmniMesh Hardware Agent
After=network.target

[Service]
ExecStart=/usr/local/bin/omnimesh-agent --hub $HUB_IP --token-file $TOKEN_FILE
Restart=always
RestartSec=10
Environment="RUST_LOG=info"

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now omnimesh-agent
    echo "--> OmniMesh agent installed and running via systemd."
else
    echo "Error: Unrecognized init system. Manual execution required."
    exit 1
fi

echo "--> Bootstrapping complete. Node should appear in the OmniMesh Dashboard shortly."
```

Invoked as:

```bash
HUB_IP=<hub-ip> BOOTSTRAP_TOKEN=<token> curl -sSL http://<HUB_IP>:4000/install.sh | bash
```

The token still exists in the environment of whatever shell ran that
command (visible via `/proc/<pid>/environ` to root/same-user, unavoidable
for this pattern) but no longer appears in `ps aux` or `~/.bash_history`,
and is written to disk read-only for root immediately, not held in the
process arg list for the agent's entire runtime.

## 10. Open Questions / Next Slice

Per the earlier discussion: the two independently-buildable starting
points are still (a) an AnvilAI worker agent talking to a stub hub — proves
registration, benchmark reporting, and job proxy/callback — or (b) the hub
+ dispatcher + Postgres schema with a manually-inserted fake node — proves
the queueing/matching logic. Neither needs the React dashboard or the
Proxmox/Unraid agents to be real yet.
