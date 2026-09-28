import { useEffect, useMemo, useState } from "react";
import { useMesh, type Job } from "./store";

function statusColor(status: string) {
  if (status === "online" || status === "done") return "bg-green-500";
  if (status === "assigned" || status === "running" || status === "installing") return "bg-yellow-500";
  if (status === "failed" || status === "offline") return "bg-red-500";
  return "bg-gray-500";
}

function NodeMatrix() {
  const nodesById = useMesh((s) => s.nodes);
  const selectedNodeId = useMesh((s) => s.selectedNodeId);
  const selectNode = useMesh((s) => s.selectNode);
  const nodes = useMemo(
    () => Object.values(nodesById).sort((a, b) => a.name.localeCompare(b.name)),
    [nodesById]
  );

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-400">Nodes</h2>
      {nodes.length === 0 && <p className="text-sm text-gray-500">No nodes registered yet.</p>}
      <div className="space-y-2">
        {nodes.map((n) => (
          <button
            key={n.id}
            onClick={() => selectNode(selectedNodeId === n.id ? null : n.id)}
            className={`flex w-full items-center justify-between rounded border px-3 py-2 text-left transition-colors ${
              selectedNodeId === n.id
                ? "border-violet-500 bg-violet-500/10"
                : "border-gray-800 hover:border-gray-700"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${statusColor(n.status)}`} />
              <span className="font-medium text-gray-200">{n.name}</span>
              <span className="text-xs text-gray-500">{n.capabilities.join(", ")}</span>
            </div>
            <div className="flex items-center gap-3">
              {n.latest_metrics && (
                <span className="font-mono text-xs text-gray-500">
                  cpu {n.latest_metrics.cpu_percent.toFixed(0)}% · mem {n.latest_metrics.mem_percent.toFixed(0)}%
                  {n.latest_metrics.temp_c != null ? ` · ${n.latest_metrics.temp_c.toFixed(0)}°C` : ""}
                </span>
              )}
              <span className="font-mono text-xs text-gray-400">
                {n.benchmark_tokens_per_sec ? `${Number(n.benchmark_tokens_per_sec).toFixed(2)} tok/s` : "—"}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function NodeDetail() {
  const selectedNodeId = useMesh((s) => s.selectedNodeId);
  const node = useMesh((s) => (s.selectedNodeId ? s.nodes[s.selectedNodeId] : null));
  const jobsById = useMesh((s) => s.jobs);
  const updateNodeConfig = useMesh((s) => s.updateNodeConfig);
  const selectNode = useMesh((s) => s.selectNode);

  const [hammerPasses, setHammerPasses] = useState("");
  const [priorityWeight, setPriorityWeight] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!node) return;
    setHammerPasses(node.config.hammer_passes?.toString() ?? "");
    setPriorityWeight(node.config.priority_weight?.toString() ?? "");
    setCapabilities(node.capabilities.join(", "));
    setSaved(false);
  }, [node]);

  const nodeJobs = useMemo(() => {
    if (!selectedNodeId) return [] as Job[];
    return Object.values(jobsById).filter((j) => j.assigned_node_id === selectedNodeId);
  }, [jobsById, selectedNodeId]);

  const finished = nodeJobs.filter((j) => j.status === "done" || j.status === "failed");
  const passed = finished.filter((j) => j.status === "done" && j.result?.hammer?.passed !== false).length;
  const successRate = finished.length > 0 ? ((passed / finished.length) * 100).toFixed(0) : null;

  if (!node) return null;

  async function handleSave() {
    await updateNodeConfig(
      node.id,
      {
        hammer_passes: hammerPasses ? Number(hammerPasses) : undefined,
        priority_weight: priorityWeight ? Number(priorityWeight) : undefined,
      },
      capabilities
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
    );
    setSaved(true);
  }

  return (
    <div className="rounded-lg border border-violet-500/50 bg-gray-900/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Node: {node.name}</h2>
        <button onClick={() => selectNode(null)} className="text-xs text-gray-500 hover:text-gray-300">
          close
        </button>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-3 text-xs text-gray-400">
        <div>
          <div className="text-gray-500">CPU</div>
          <div className="font-mono text-gray-200">
            {node.latest_metrics ? `${node.latest_metrics.cpu_percent.toFixed(1)}%` : "—"}
          </div>
        </div>
        <div>
          <div className="text-gray-500">Memory</div>
          <div className="font-mono text-gray-200">
            {node.latest_metrics ? `${node.latest_metrics.mem_percent.toFixed(1)}%` : "—"}
          </div>
        </div>
        <div>
          <div className="text-gray-500">Temp</div>
          <div className="font-mono text-gray-200">
            {node.latest_metrics?.temp_c != null ? `${node.latest_metrics.temp_c.toFixed(1)}°C` : "—"}
          </div>
        </div>
        <div>
          <div className="text-gray-500">Benchmark</div>
          <div className="font-mono text-gray-200">
            {node.benchmark_tokens_per_sec ? `${Number(node.benchmark_tokens_per_sec).toFixed(2)} tok/s` : "—"}
          </div>
        </div>
        <div>
          <div className="text-gray-500">Jobs (finished)</div>
          <div className="font-mono text-gray-200">{finished.length}</div>
        </div>
        <div>
          <div className="text-gray-500">Success rate</div>
          <div className="font-mono text-gray-200">{successRate != null ? `${successRate}%` : "—"}</div>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-3">
        <label className="text-xs text-gray-500">
          Hammer passes
          <input
            value={hammerPasses}
            onChange={(e) => setHammerPasses(e.target.value)}
            placeholder="default"
            className="mt-1 w-full rounded border border-gray-800 bg-black/30 p-1.5 font-mono text-xs text-gray-200 outline-none focus:border-gray-600"
          />
        </label>
        <label className="text-xs text-gray-500">
          Priority weight
          <input
            value={priorityWeight}
            onChange={(e) => setPriorityWeight(e.target.value)}
            placeholder="1"
            className="mt-1 w-full rounded border border-gray-800 bg-black/30 p-1.5 font-mono text-xs text-gray-200 outline-none focus:border-gray-600"
          />
        </label>
        <label className="text-xs text-gray-500">
          Capabilities
          <input
            value={capabilities}
            onChange={(e) => setCapabilities(e.target.value)}
            placeholder="llm_generation"
            className="mt-1 w-full rounded border border-gray-800 bg-black/30 p-1.5 font-mono text-xs text-gray-200 outline-none focus:border-gray-600"
          />
        </label>
      </div>
      <p className="mb-3 text-xs text-gray-600">
        Note: temperature range isn't wired up to the generation loop yet - only hammer passes and
        capabilities take effect right now.
      </p>
      <button
        onClick={handleSave}
        className="rounded bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500"
      >
        {saved ? "Saved" : "Save config"}
      </button>

      <h3 className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Recent jobs on this node
      </h3>
      <div className="space-y-1">
        {nodeJobs.length === 0 && <p className="text-xs text-gray-600">No jobs assigned to this node yet.</p>}
        {nodeJobs.slice(0, 10).map((j) => (
          <div key={j.id} className="flex items-center gap-2 text-xs">
            <span className={`h-1.5 w-1.5 rounded-full ${statusColor(j.status)}`} />
            <span className="font-mono text-gray-500">{j.id.slice(0, 8)}</span>
            <span className="text-gray-400">{j.status}</span>
            {j.result?.hammer && <span className="text-gray-500">passes={j.result.hammer.passes_used}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function JobStream() {
  const jobsById = useMesh((s) => s.jobs);
  const jobs = useMemo(
    () =>
      Object.values(jobsById).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    [jobsById]
  );

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-400">Jobs</h2>
      {jobs.length === 0 && <p className="text-sm text-gray-500">No jobs yet.</p>}
      <div className="space-y-2">
        {jobs.map((j) => (
          <div key={j.id} className="rounded border border-gray-800 px-3 py-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${statusColor(j.status)}`} />
                <span className="font-mono text-xs text-gray-500">{j.id.slice(0, 8)}</span>
                <span className="text-xs text-gray-400">{j.status}</span>
                {j.result?.hammer && (
                  <span className="text-xs text-gray-500">
                    passed={String(j.result.hammer.passed)} passes={j.result.hammer.passes_used}
                  </span>
                )}
              </div>
            </div>
            {j.payload?.content && (
              <p className="mt-1 truncate text-xs text-gray-500">{j.payload.content.split("\n")[0]}</p>
            )}
            {j.result?.choices?.[0]?.message?.content && (
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 text-xs text-gray-300">
                {j.result.choices[0].message.content}
              </pre>
            )}
            {j.error && <p className="mt-1 text-xs text-red-400">{j.error}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function SubmitJobForm() {
  const submitJob = useMesh((s) => s.submitJob);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    setBusy(true);
    await submitJob(content);
    setContent("");
    setBusy(false);
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-400">Submit Job</h2>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={'Task text, optionally with a fenced ```test block...'}
        className="h-28 w-full rounded border border-gray-800 bg-black/30 p-2 font-mono text-xs text-gray-200 outline-none focus:border-gray-600"
      />
      <button
        type="submit"
        disabled={busy}
        className="mt-2 rounded bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
      >
        {busy ? "Submitting..." : "Submit"}
      </button>
    </form>
  );
}

export default function App() {
  const init = useMesh((s) => s.init);
  const connectWs = useMesh((s) => s.connectWs);
  const connected = useMesh((s) => s.connected);

  useEffect(() => {
    init();
    connectWs();
  }, [init, connectWs]);

  return (
    <div className="min-h-screen bg-[#0b0d12] p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-100">OmniMesh</h1>
          <span className={`text-xs ${connected ? "text-green-400" : "text-red-400"}`}>
            {connected ? "live" : "disconnected"}
          </span>
        </div>
        <div className="grid gap-4">
          <NodeMatrix />
          <NodeDetail />
          <JobStream />
          <SubmitJobForm />
        </div>
      </div>
    </div>
  );
}
