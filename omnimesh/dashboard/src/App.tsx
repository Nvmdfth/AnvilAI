import { useEffect, useMemo, useState } from "react";
import { useMesh } from "./store";

function statusColor(status: string) {
  if (status === "online" || status === "done") return "bg-green-500";
  if (status === "assigned" || status === "running") return "bg-yellow-500";
  if (status === "failed" || status === "offline") return "bg-red-500";
  return "bg-gray-500";
}

function NodeMatrix() {
  const nodesById = useMesh((s) => s.nodes);
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
          <div key={n.id} className="flex items-center justify-between rounded border border-gray-800 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${statusColor(n.status)}`} />
              <span className="font-medium text-gray-200">{n.name}</span>
              <span className="text-xs text-gray-500">{n.capabilities.join(", ")}</span>
            </div>
            <span className="font-mono text-xs text-gray-400">
              {n.benchmark_tokens_per_sec ? `${Number(n.benchmark_tokens_per_sec).toFixed(2)} tok/s` : "—"}
            </span>
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
          <JobStream />
          <SubmitJobForm />
        </div>
      </div>
    </div>
  );
}
