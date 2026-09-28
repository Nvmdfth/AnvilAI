import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "http";
import { db } from "./db.js";
import { attachWebSocket, broadcast } from "./broadcast.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// In-process wake-up for /v1/chat/completions's blocking wait - avoids
// polling the DB. A single hub instance only (no horizontal scaling
// today), so an in-memory map is sufficient; a multi-instance hub would
// need this to move to LISTEN/NOTIFY or similar.
const jobWaiters = new Map<string, { resolve: (job: Record<string, unknown>) => void }>();

// MVP auth: a single shared bearer token for every node. Real per-node
// bootstrap tokens (Omnimesh.md §7) come once there's more than one
// node and per-node revocation actually matters.
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? "dev-only-token";

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== AGENT_TOKEN) {
    res.status(401).json({ error: "invalid or missing bearer token" });
    return;
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Node registration - upsert by name, so re-running an agent just
// updates its own row instead of creating duplicates.
app.post("/nodes/register", requireAuth, async (req, res) => {
  const { name, host_address, capabilities, hardware_metadata, status } = req.body ?? {};
  if (!name || !Array.isArray(capabilities)) {
    res.status(400).json({ error: "name and capabilities[] are required" });
    return;
  }

  // Agents that aren't ready for work yet (e.g. still downloading
  // llama-server/model on first install) report status: "installing"
  // here instead of the default "online" - see main.rs's readiness
  // probe. The heartbeat endpoint below is what refreshes last_seen_at
  // while they wait; re-registering isn't required.
  const initialStatus = status ?? "online";

  const result = await db.query(
    `INSERT INTO nodes (name, host_address, capabilities, hardware_metadata, status, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (name) DO UPDATE SET
       host_address = EXCLUDED.host_address,
       capabilities = EXCLUDED.capabilities,
       hardware_metadata = EXCLUDED.hardware_metadata,
       status = EXCLUDED.status,
       last_seen_at = now()
     RETURNING *`,
    [name, host_address ?? null, capabilities, hardware_metadata ?? {}, initialStatus]
  );

  broadcast("node", result.rows[0]);
  res.json({ node_id: result.rows[0].id });
});

app.get("/nodes", async (_req, res) => {
  const result = await db.query(`SELECT * FROM nodes ORDER BY name`);
  res.json(result.rows);
});

// Heartbeat + benchmark report.
app.post("/nodes/:id/heartbeat", requireAuth, async (req, res) => {
  const { benchmark_tokens_per_sec, status } = req.body ?? {};
  const result = await db.query(
    `UPDATE nodes SET status = $3, last_seen_at = now(),
       benchmark_tokens_per_sec = COALESCE($2, benchmark_tokens_per_sec),
       benchmark_updated_at = CASE WHEN $2 IS NOT NULL THEN now() ELSE benchmark_updated_at END
     WHERE id = $1 RETURNING *`,
    [req.params.id, benchmark_tokens_per_sec ?? null, status ?? "online"]
  );
  if (result.rows[0]) broadcast("node", result.rows[0]);
  res.json({ ok: true });
});

// A node polls this to ask for work. Assignment is a single atomic
// UPDATE ... RETURNING with FOR UPDATE SKIP LOCKED semantics via a
// subquery, so two nodes polling at once can't grab the same job.
app.post("/nodes/:id/poll", requireAuth, async (req, res) => {
  const nodeId = req.params.id;
  const { capability, metrics } = req.body ?? {};
  if (!capability) {
    res.status(400).json({ error: "capability is required" });
    return;
  }

  // Piggyback live resource metrics on the poll the agent already does
  // every few seconds, instead of a second reporting loop.
  const nodeUpdate = await db.query(
    `UPDATE nodes SET status = 'online', last_seen_at = now(),
       latest_metrics = COALESCE($2::jsonb, latest_metrics),
       metrics_updated_at = CASE WHEN $2::jsonb IS NOT NULL THEN now() ELSE metrics_updated_at END
     WHERE id = $1 RETURNING *`,
    [nodeId, metrics ? JSON.stringify(metrics) : null]
  );
  if (nodeUpdate.rows[0]) broadcast("node", nodeUpdate.rows[0]);
  const nodeConfig = nodeUpdate.rows[0]?.config ?? {};

  const result = await db.query(
    `UPDATE jobs SET status = 'assigned', assigned_node_id = $2, assigned_at = now()
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued' AND required_capability = $1
       ORDER BY priority DESC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [capability, nodeId]
  );

  if (result.rows.length === 0) {
    res.status(204).end();
    return;
  }
  broadcast("job", result.rows[0]);
  // Send the node's current config along so the agent can apply
  // overrides (e.g. hammer_passes) without a separate fetch.
  res.json({ ...result.rows[0], node_config: nodeConfig });
});

// Dashboard edits a node's tunable config (hammer params, scheduler
// weight) or its capabilities/priority. Partial update - only given
// fields change.
app.patch("/nodes/:id/config", async (req, res) => {
  const { config, capabilities, priority_weight } = req.body ?? {};

  const mergedConfig = { ...(config ?? {}) };
  if (priority_weight !== undefined) mergedConfig.priority_weight = priority_weight;

  const result = await db.query(
    `UPDATE nodes SET
       config = config || $2::jsonb,
       capabilities = COALESCE($3, capabilities)
     WHERE id = $1 RETURNING *`,
    [req.params.id, JSON.stringify(mergedConfig), capabilities ?? null]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  broadcast("node", result.rows[0]);
  res.json(result.rows[0]);
});

// Submit a job (from a person or another service, not a node).
app.post("/jobs", async (req, res) => {
  const { job_type, required_capability, payload, priority } = req.body ?? {};
  if (!job_type || !required_capability || !payload) {
    res.status(400).json({ error: "job_type, required_capability, and payload are required" });
    return;
  }

  const result = await db.query(
    `INSERT INTO jobs (job_type, required_capability, payload, priority)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [job_type, required_capability, payload, priority ?? 0]
  );

  broadcast("job", result.rows[0]);
  res.json({ job_id: result.rows[0].id });
});

app.get("/jobs", async (_req, res) => {
  const result = await db.query(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200`);
  res.json(result.rows);
});

app.get("/jobs/:id", async (req, res) => {
  const result = await db.query(`SELECT * FROM jobs WHERE id = $1`, [req.params.id]);
  if (result.rows.length === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(result.rows[0]);
});

// A node reports a job's outcome.
app.post("/jobs/:id/result", requireAuth, async (req, res) => {
  const { status, result: jobResult, error } = req.body ?? {};
  if (status !== "done" && status !== "failed") {
    res.status(400).json({ error: "status must be 'done' or 'failed'" });
    return;
  }

  const result = await db.query(
    `UPDATE jobs SET status = $2, result = $3, error = $4, completed_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id, status, jobResult ?? null, error ?? null]
  );

  if (result.rows[0]) {
    broadcast("job", result.rows[0]);
    const waiter = jobWaiters.get(req.params.id);
    if (waiter) {
      jobWaiters.delete(req.params.id);
      waiter.resolve(result.rows[0]);
    }
  }
  res.json({ ok: true });
});

// OpenAI-compatible entry point - point any OpenAI client (VS Code
// extensions included) at http://<hub>:4000/v1, API key = AGENT_TOKEN.
// Translates the request into a plain job, blocks until a node reports
// a result via /jobs/:id/result (jobWaiters above), and relays that
// result back - it's already OpenAI-shaped, since that's what
// hammer-api's own /v1/chat/completions returns (see engine/api.py).
const CHAT_JOB_TIMEOUT_MS = Number(process.env.CHAT_JOB_TIMEOUT_MS ?? 600_000);

app.post("/v1/chat/completions", requireAuth, async (req, res) => {
  const { model, messages, stream } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: { message: "messages[] is required", type: "invalid_request_error" } });
    return;
  }

  const insertResult = await db.query(
    `INSERT INTO jobs (job_type, required_capability, payload, priority)
     VALUES ('llm_generation', 'llm_generation', $1, 0) RETURNING *`,
    [{ messages }]
  );
  const job = insertResult.rows[0];
  broadcast("job", job);

  const donePromise = new Promise<Record<string, unknown>>((resolve) => {
    jobWaiters.set(job.id, { resolve });
  });
  const timeoutPromise = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), CHAT_JOB_TIMEOUT_MS)
  );

  const outcome = await Promise.race([donePromise, timeoutPromise]);
  if (outcome === "timeout") {
    jobWaiters.delete(job.id);
    res.status(504).json({
      error: {
        message: `job ${job.id} did not complete within ${CHAT_JOB_TIMEOUT_MS}ms - it may still finish; check GET /jobs/${job.id}`,
        type: "timeout_error",
      },
    });
    return;
  }

  const finishedJob = outcome;
  if (finishedJob.status === "failed") {
    res.status(502).json({ error: { message: String(finishedJob.error ?? "job failed"), type: "server_error" } });
    return;
  }

  // hammer-api's response is already OpenAI chat-completion shaped -
  // relay it, just echoing back whatever model name the client asked for.
  const result = finishedJob.result as Record<string, unknown>;
  const body = { ...result, model: model ?? result.model };

  if (!stream) {
    res.json(body);
    return;
  }

  // Faked streaming: the hammer loop only produces a final answer after
  // several full generate/verify passes, so there's nothing meaningful
  // to stream incrementally - emit the whole thing as one SSE chunk so
  // clients that always request stream: true (many do by default) still
  // get a response shaped the way they expect, instead of erroring on a
  // stray non-SSE body.
  const choice = (body as any).choices?.[0];
  const chunk = {
    id: result.id,
    object: "chat.completion.chunk",
    created: result.created,
    model: body.model,
    choices: [{ index: 0, delta: { role: "assistant", content: choice?.message?.content ?? "" }, finish_reason: null }],
  };
  const finalChunk = {
    id: result.id,
    object: "chat.completion.chunk",
    created: result.created,
    model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason ?? "stop" }],
  };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

const port = Number(process.env.PORT ?? 4000);
const httpServer = createServer(app);
attachWebSocket(httpServer);
httpServer.listen(port, () => {
  console.log(`omnimesh-hub listening on :${port} (ws at /ws)`);
});
