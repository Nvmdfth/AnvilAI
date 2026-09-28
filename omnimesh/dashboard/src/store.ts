import { create } from "zustand";

export interface Node {
  id: string;
  name: string;
  host_address: string | null;
  status: string;
  capabilities: string[];
  hardware_metadata: Record<string, unknown>;
  benchmark_tokens_per_sec: number | null;
  benchmark_updated_at: string | null;
  last_seen_at: string | null;
}

export interface Job {
  id: string;
  job_type: string;
  required_capability: string;
  priority: number;
  payload: { content?: string };
  status: string;
  assigned_node_id: string | null;
  result: { hammer?: { passed: boolean; passes_used: number }; choices?: { message: { content: string } }[] } | null;
  error: string | null;
  created_at: string;
  assigned_at: string | null;
  completed_at: string | null;
}

interface MeshState {
  nodes: Record<string, Node>;
  jobs: Record<string, Job>;
  connected: boolean;
  init: () => Promise<void>;
  connectWs: () => void;
  submitJob: (content: string) => Promise<void>;
}

export const useMesh = create<MeshState>((set, get) => ({
  nodes: {},
  jobs: {},
  connected: false,

  init: async () => {
    const [nodesRes, jobsRes] = await Promise.all([fetch("/api/nodes"), fetch("/api/jobs")]);
    const nodes: Node[] = await nodesRes.json();
    const jobs: Job[] = await jobsRes.json();
    set({
      nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
      jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
    });
  },

  connectWs: () => {
    const url = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
    const ws = new WebSocket(url);

    ws.onopen = () => set({ connected: true });
    ws.onclose = () => {
      set({ connected: false });
      setTimeout(() => get().connectWs(), 2000);
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "node") {
        set((s) => ({ nodes: { ...s.nodes, [msg.data.id]: msg.data } }));
      } else if (msg.type === "job") {
        set((s) => ({ jobs: { ...s.jobs, [msg.data.id]: msg.data } }));
      }
    };
  },

  submitJob: async (content: string) => {
    await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_type: "llm_generation",
        required_capability: "llm_generation",
        payload: { content },
      }),
    });
  },
}));
