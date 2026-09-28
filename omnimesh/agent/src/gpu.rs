use serde_json::{json, Value};
use std::process::Command;

// Windows-only for now (see ../README.md's "Windows" section - no
// install flow existed at all until this change). Linux nodes are
// GPU-less Pis today; cross-platform detection can follow when that
// changes.
#[cfg(not(target_os = "windows"))]
pub fn detect() -> Vec<Value> {
    Vec::new()
}

#[cfg(target_os = "windows")]
pub fn detect() -> Vec<Value> {
    let mut gpus = detect_nvidia();
    let known_names: Vec<String> = gpus
        .iter()
        .filter_map(|g| g["name"].as_str().map(|s| s.to_string()))
        .collect();

    for gpu in detect_wmi() {
        let name = gpu["name"].as_str().unwrap_or_default();
        if !known_names.iter().any(|n| n == name) {
            gpus.push(gpu);
        }
    }

    gpus
}

// nvidia-smi gives accurate VRAM; WMI's AdapterRAM is a 32-bit field
// that misreports (wraps/caps) on cards with >4GB VRAM, so we prefer
// this source whenever it's available.
#[cfg(target_os = "windows")]
fn detect_nvidia() -> Vec<Value> {
    let output = match Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            let name = parts.first()?.to_string();
            if name.is_empty() {
                return None;
            }
            let vram_mb = parts.get(1).and_then(|v| v.parse::<u64>().ok());
            let driver_version = parts.get(2).map(|s| s.to_string());
            Some(json!({
                "name": name,
                "vendor": "nvidia",
                "vram_mb": vram_mb,
                "driver_version": driver_version,
            }))
        })
        .collect()
}

// Fallback covering AMD/Intel/anything else via WMI, and NVIDIA cards
// nvidia-smi missed (no driver installed, PATH issue, etc). AdapterRAM
// is reported as-is (unreliable above 4GB - see detect_nvidia comment).
#[cfg(target_os = "windows")]
fn detect_wmi() -> Vec<Value> {
    let output = match Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,AdapterCompatibility | ConvertTo-Json -Compress",
        ])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = match serde_json::from_str(stdout.trim()) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    // A single controller comes back as an object, not an array.
    let entries: Vec<Value> = match parsed {
        Value::Array(a) => a,
        Value::Object(_) => vec![parsed],
        _ => Vec::new(),
    };

    entries
        .into_iter()
        .filter_map(|entry| {
            let name = entry["Name"].as_str()?.to_string();
            let vram_mb = entry["AdapterRAM"].as_u64().map(|bytes| bytes / (1024 * 1024));
            let vendor = entry["AdapterCompatibility"]
                .as_str()
                .unwrap_or("unknown")
                .to_lowercase();
            Some(json!({
                "name": name,
                "vendor": vendor,
                "vram_mb": vram_mb,
                "driver_version": Value::Null,
            }))
        })
        .collect()
}
