import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "http";
import { db } from "./db.js";
import { attachWebSocket, broadcast } from "./broadcast.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

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
  const { name, host_address, capabilities, hardware_metadata } = req.body ?? {};
  if (!name || !Array.isArray(capabilities)) {
    res.status(400).json({ error: "name and capabilities[] are required" });
    return;
  }

  const result = await db.query(
    `INSERT INTO nodes (name, host_address, capabilities, hardware_metadata, status, last_seen_at)
     VALUES ($1, $2, $3, $4, 'online', now())
     ON CONFLICT (name) DO UPDATE SET
       host_address = EXCLUDED.host_address,
       capabilities = EXCLUDED.capabilities,
       hardware_metadata = EXCLUDED.hardware_metadata,
       status = 'online',
       last_seen_at = now()
     RETURNING *`,
    [name, host_address ?? null, capabilities, hardware_metadata ?? {}]
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
  const { benchmark_tokens_per_sec } = req.body ?? {};
  const result = await db.query(
    `UPDATE nodes SET status = 'online', last_seen_at = now(),
       benchmark_tokens_per_sec = COALESCE($2, benchmark_tokens_per_sec),
       benchmark_updated_at = CASE WHEN $2 IS NOT NULL THEN now() ELSE benchmark_updated_at END
     WHERE id = $1 RETURNING *`,
    [req.params.id, benchmark_tokens_per_sec ?? null]
  );
  if (result.rows[0]) broadcast("node", result.rows[0]);
  res.json({ ok: true });
});

// A node polls this to ask for work. Assignment is a single atomic
// UPDATE ... RETURNING with FOR UPDATE SKIP LOCKED semantics via a
// subquery, so two nodes polling at once can't grab the same job.
app.post("/nodes/:id/poll", requireAuth, async (req, res) => {
  const nodeId = req.params.id;
  const { capability } = req.body ?? {};
  if (!capability) {
    res.status(400).json({ error: "capability is required" });
    return;
  }

  const nodeUpdate = await db.query(
    `UPDATE nodes SET status = 'online', last_seen_at = now() WHERE id = $1 RETURNING *`,
    [nodeId]
  );
  if (nodeUpdate.rows[0]) broadcast("node", nodeUpdate.rows[0]);

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

  if (result.rows[0]) broadcast("job", result.rows[0]);
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 4000);
const httpServer = createServer(app);
attachWebSocket(httpServer);
httpServer.listen(port, () => {
  console.log(`omnimesh-hub listening on :${port} (ws at /ws)`);
});
