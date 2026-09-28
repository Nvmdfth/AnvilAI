use serde_json::{json, Value};
use std::env;
use std::fs;
use std::time::Duration;
use sysinfo::System;

mod gpu;

struct Config {
    hub_url: String,
    agent_token: String,
    node_name: String,
    local_llama_url: String,
    local_hammer_api: String,
    capability: String,
    poll_interval: Duration,
}

fn config_from_env() -> Config {
    Config {
        hub_url: env::var("HUB_URL").unwrap_or_else(|_| "http://localhost:4000".into()),
        agent_token: env::var("AGENT_TOKEN").unwrap_or_else(|_| "dev-only-token".into()),
        node_name: env::var("NODE_NAME").unwrap_or_else(|_| {
            hostname::get()
                .map(|h| h.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "unknown-node".into())
        }),
        local_llama_url: env::var("LOCAL_LLAMA_URL").unwrap_or_else(|_| "http://localhost:8080".into()),
        local_hammer_api: env::var("LOCAL_HAMMER_API").unwrap_or_else(|_| "http://localhost:8001".into()),
        capability: env::var("CAPABILITY").unwrap_or_else(|_| "llm_generation".into()),
        poll_interval: Duration::from_secs(
            env::var("POLL_INTERVAL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(3),
        ),
    }
}

// Benchmarks by hitting llama-server directly (not hammer-api), because
// llama-server's raw response includes real generation timings - static
// specs can't be trusted (see Omnimesh.md §4: this exact class of Pi has
// no dotprod/i8mm, invisible to /proc/cpuinfo-style metadata).
async fn benchmark(client: &reqwest::Client, cfg: &Config) -> Option<f64> {
    let body = json!({
        "messages": [{"role": "user", "content": "Count from 1 to 20."}],
        "temperature": 0.0
    });
    let resp = client
        .post(format!("{}/v1/chat/completions", cfg.local_llama_url))
        .json(&body)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .ok()?;
    let data: Value = resp.json().await.ok()?;
    data["timings"]["predicted_per_second"].as_f64()
}

// Readiness gate for "online" status. hammer-api is what execute_job
// actually talks to (not llama-server directly), and its own /health
// already checks its upstream llama-server underneath - so this is the
// one call that reflects whether the node can truly serve a request,
// as opposed to benchmark() below, which only proves llama-server
// itself is up.
async fn hammer_api_healthy(client: &reqwest::Client, cfg: &Config) -> bool {
    client
        .get(format!("{}/health", cfg.local_hammer_api))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map(|resp| resp.status().is_success())
        .unwrap_or(false)
}

// CPU/mem via sysinfo (cross-platform); temperature via the Linux
// thermal zone file directly - sysinfo's component API is unreliable
// across ARM boards, and this file is the one thing we already know
// exists on this exact hardware.
fn collect_metrics(sys: &mut System) -> Value {
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpu_percent = sys.global_cpu_usage();
    let mem_percent = if sys.total_memory() > 0 {
        (sys.used_memory() as f64 / sys.total_memory() as f64) * 100.0
    } else {
        0.0
    };
    let temp_c = fs::read_to_string("/sys/class/thermal/thermal_zone0/temp")
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .map(|milli_c| milli_c / 1000.0);

    json!({"cpu_percent": cpu_percent, "mem_percent": mem_percent, "temp_c": temp_c})
}

async fn register(client: &reqwest::Client, cfg: &Config, status: &str) -> Option<String> {
    let body = json!({
        "name": cfg.node_name,
        "host_address": Option::<String>::None,
        "capabilities": [cfg.capability],
        "hardware_metadata": {"cores": num_cpus::get(), "gpus": gpu::detect()},
        "status": status,
    });
    let resp = client
        .post(format!("{}/nodes/register", cfg.hub_url))
        .bearer_auth(&cfg.agent_token)
        .json(&body)
        .send()
        .await
        .ok()?;
    let data: Value = resp.json().await.ok()?;
    Some(data["node_id"].as_str()?.to_string())
}

async fn heartbeat(client: &reqwest::Client, cfg: &Config, node_id: &str, status: &str, benchmark_score: Option<f64>) {
    let _ = client
        .post(format!("{}/nodes/{}/heartbeat", cfg.hub_url, node_id))
        .bearer_auth(&cfg.agent_token)
        .json(&json!({"status": status, "benchmark_tokens_per_sec": benchmark_score}))
        .send()
        .await;
}

// Job payload contract: {"content": "<full user message text, including
// any ```test fence the submitter wants hammer-api to see>"}. The agent
// is a dumb proxy - it doesn't know or care what's inside `content`.
// node_config's `hammer_passes` (dashboard-tunable, see Omnimesh.md
// node-detail panel) overrides the hammer-api default. `temperature_min`/
// `temperature_max` are stored in config too but not wired up yet -
// hammer_code's temperature escalation is still hardcoded in hammer.py,
// so setting them here would be a config field with no real effect.
async fn execute_job(client: &reqwest::Client, cfg: &Config, payload: &Value, node_config: &Value) -> Result<Value, String> {
    let content = payload["content"].as_str().ok_or("payload.content missing")?;
    let mut body = json!({"messages": [{"role": "user", "content": content}]});
    if let Some(passes) = node_config["hammer_passes"].as_i64() {
        body["passes"] = json!(passes);
    }

    let resp = client
        .post(format!("{}/v1/chat/completions", cfg.local_hammer_api))
        .json(&body)
        .timeout(Duration::from_secs(900))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.json::<Value>().await.map_err(|e| e.to_string())
}

async fn report_result(client: &reqwest::Client, cfg: &Config, job_id: &str, outcome: Result<Value, String>) {
    let body = match outcome {
        Ok(result) => json!({"status": "done", "result": result}),
        Err(error) => json!({"status": "failed", "error": error}),
    };
    let _ = client
        .post(format!("{}/jobs/{}/result", cfg.hub_url, job_id))
        .bearer_auth(&cfg.agent_token)
        .json(&body)
        .send()
        .await;
}

#[tokio::main]
async fn main() {
    let cfg = config_from_env();
    let client = reqwest::Client::new();

    println!("omnimesh-agent starting: node={} hub={}", cfg.node_name, cfg.hub_url);

    // Register first, unconditionally "installing" - before probing
    // anything. Installation (llama-server/model download, hammer-api
    // venv setup - see ../scripts/install.ps1/.sh) may still be running at
    // this point; the node must show up in the dashboard right away,
    // but never as ready.
    let node_id = match register(&client, &cfg, "installing").await {
        Some(id) => {
            println!("registered as node_id={}", id);
            id
        }
        None => {
            eprintln!("failed to register with hub, exiting");
            return;
        }
    };

    // Gate "online" on hammer-api's /health, not benchmark() - that's
    // the actual request path execute_job uses, and its /health already
    // checks llama-server underneath. Keep heartbeating meanwhile so
    // the node doesn't look stale/dead in the dashboard, but never call
    // /poll ("give me work") until this passes - the hub doesn't
    // otherwise filter job assignment by node status.
    while !hammer_api_healthy(&client, &cfg).await {
        heartbeat(&client, &cfg, &node_id, "installing", None).await;
        tokio::time::sleep(cfg.poll_interval).await;
    }

    println!("hammer-api healthy, running local benchmark...");
    let score = benchmark(&client, &cfg).await;
    println!("benchmark: {:?} tok/s, node ready", score);
    heartbeat(&client, &cfg, &node_id, "online", score).await;

    let mut sys = System::new_all();

    loop {
        let metrics = collect_metrics(&mut sys);
        let poll_resp = client
            .post(format!("{}/nodes/{}/poll", cfg.hub_url, node_id))
            .bearer_auth(&cfg.agent_token)
            .json(&json!({"capability": cfg.capability, "metrics": metrics}))
            .send()
            .await;

        match poll_resp {
            Ok(resp) if resp.status() == reqwest::StatusCode::NO_CONTENT => {
                tokio::time::sleep(cfg.poll_interval).await;
            }
            Ok(resp) => {
                match resp.json::<Value>().await {
                    Ok(job) => {
                        let job_id = job["id"].as_str().unwrap_or_default().to_string();
                        let node_config = job["node_config"].clone();
                        println!("got job {}", job_id);
                        let outcome = execute_job(&client, &cfg, &job["payload"], &node_config).await;
                        println!("job {} outcome: {:?}", job_id, outcome.is_ok());
                        report_result(&client, &cfg, &job_id, outcome).await;
                    }
                    Err(e) => {
                        eprintln!("bad job response: {}", e);
                        tokio::time::sleep(cfg.poll_interval).await;
                    }
                }
            }
            Err(e) => {
                eprintln!("poll failed: {}", e);
                tokio::time::sleep(cfg.poll_interval).await;
            }
        }
    }
}
