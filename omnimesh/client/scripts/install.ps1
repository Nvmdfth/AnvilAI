# AnvilAI standalone installer (Windows).
#
# Usage (from an elevated or regular PowerShell - no admin required):
#   irm https://raw.githubusercontent.com/Nvmdfth/AnvilAI.git/main/omnimesh/client/scripts/install.ps1 | iex
#
# Installs a prebuilt llama-server (GPU backend if detected, else CPU),
# the default model, and hammer-api under %LOCALAPPDATA%\AnvilAI, and
# registers both as logon-triggered Scheduled Tasks (no admin rights
# needed, unlike a Windows service). Mirrors install.sh (Linux); see
# that script for the systemd-based equivalent.
$ErrorActionPreference = "Stop"
# Invoke-WebRequest's default progress bar is notoriously CPU-heavy and
# slow in Windows PowerShell 5.1 for large files - it can turn a 600MB
# download that should take under a minute into one that spins a full
# CPU core for 10+ minutes. This is the single biggest fix for install
# speed here.
$ProgressPreference = "SilentlyContinue"

$InstallDir = "$env:LOCALAPPDATA\AnvilAI"
$RepoUrl = "https://github.com/Nvmdfth/AnvilAI.git"

# Pinned llama.cpp release build - keep in sync with install.sh's
# LLAMA_RELEASE_TAG. llama.cpp ships many non-semver (b#####) builds a
# day; bump deliberately after testing, don't chase latest.
$LlamaReleaseTag = "b11232"

$ModelUrl = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"
$ModelFile = "qwen2.5-1.5b-instruct-q4_k_m.gguf"

$LlamaThreads = if ($env:LLAMA_THREADS) { $env:LLAMA_THREADS } else { "3" }
$LlamaCtxSize = if ($env:LLAMA_CTX_SIZE) { $env:LLAMA_CTX_SIZE } else { "4096" }
$LlamaPort    = if ($env:LLAMA_PORT)     { $env:LLAMA_PORT }     else { "8080" }
$HammerPort   = if ($env:HAMMER_PORT)    { $env:HAMMER_PORT }    else { "8001" }

Write-Host "--> Detecting GPU..."
$Backend = "cpu"
$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvidiaSmi -and (& nvidia-smi -L 2>$null) -and $LASTEXITCODE -eq 0) {
    $Backend = "cuda"
} elseif (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name }) {
    # Any GPU (AMD/Intel/unrecognized) - Vulkan works broadly on modern
    # drivers without a vendor SDK. ROCm/SYCL exist as llama.cpp release
    # assets too but need extra vendor runtimes installed; not worth the
    # fragility here.
    $Backend = "vulkan"
}
Write-Host "--> Backend: $Backend"

# Windows CUDA builds don't statically link the CUDA runtime the way the
# Linux ubuntu-cuda asset effectively assumes one's present - llama.cpp
# ships it as a separate "cudart-*" zip that must land next to the exe,
# or llama-server.exe fails to start with a missing-DLL error. No
# equivalent step exists on Linux.
$Asset = switch ($Backend) {
    "cuda"   { "llama-$LlamaReleaseTag-bin-win-cuda-12.4-x64.zip" }
    "vulkan" { "llama-$LlamaReleaseTag-bin-win-vulkan-x64.zip" }
    default  { "llama-$LlamaReleaseTag-bin-win-cpu-x64.zip" }
}
$CudartAsset = "cudart-llama-bin-win-cuda-12.4-x64.zip"
$LlamaUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaReleaseTag/$Asset"
$CudartUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaReleaseTag/$CudartAsset"

New-Item -ItemType Directory -Force -Path "$InstallDir\bin", "$InstallDir\models", "$InstallDir\logs" | Out-Null

# Stamped with tag+backend on a successful extract, below. Re-running
# the installer for the same pinned release/backend (e.g. just to pick
# up a new HAMMER_PORT) shouldn't re-download ~600MB of binaries, and
# skipping also avoids fighting Expand-Archive over DLLs still locked
# by a running llama-server.exe from a prior install.
$VersionFile = "$InstallDir\bin\.llama-version"
$CurrentVersion = "$LlamaReleaseTag-$Backend"
$AlreadyInstalled = (Test-Path $VersionFile) -and ((Get-Content $VersionFile -Raw).Trim() -eq $CurrentVersion) -and (Test-Path "$InstallDir\bin\llama-server.exe")

if ($AlreadyInstalled) {
    Write-Host "--> llama.cpp $CurrentVersion already installed, skipping download."
} else {
    Write-Host "--> Downloading llama.cpp ($Asset)..."
    # Expand-Archive requires a .zip extension - New-TemporaryFile gives .tmp.
    $TmpZip = Join-Path $env:TEMP "anvilai-llama-$([guid]::NewGuid()).zip"
    Invoke-WebRequest -Uri $LlamaUrl -OutFile $TmpZip
    Expand-Archive -Path $TmpZip -DestinationPath "$InstallDir\bin" -Force
    Remove-Item $TmpZip -Force

    if ($Backend -eq "cuda") {
        Write-Host "--> Downloading CUDA runtime ($CudartAsset)..."
        $TmpCudart = Join-Path $env:TEMP "anvilai-cudart-$([guid]::NewGuid()).zip"
        Invoke-WebRequest -Uri $CudartUrl -OutFile $TmpCudart
        Expand-Archive -Path $TmpCudart -DestinationPath "$InstallDir\bin" -Force
        Remove-Item $TmpCudart -Force
    }

    Set-Content -Path $VersionFile -Value $CurrentVersion -Encoding utf8 -NoNewline
}

$ModelPath = "$InstallDir\models\$ModelFile"
if (-not (Test-Path $ModelPath)) {
    Write-Host "--> Downloading default model (~1.1GB)..."
    Invoke-WebRequest -Uri $ModelUrl -OutFile "$ModelPath.part"
    Move-Item "$ModelPath.part" $ModelPath
} else {
    Write-Host "--> Model already present, skipping download."
}

Write-Host "--> Fetching AnvilAI source..."
if (Test-Path "$InstallDir\src\.git") {
    git -C "$InstallDir\src" pull --quiet
} else {
    if (Test-Path "$InstallDir\src") { Remove-Item -Recurse -Force "$InstallDir\src" }
    git clone --quiet --depth 1 $RepoUrl "$InstallDir\src"
}

Write-Host "--> Setting up hammer-api venv..."
python -m venv "$InstallDir\venv"
# Upgrading pip via pip.exe itself fails on Windows (can't replace its
# own running executable) - go through python.exe -m pip instead.
& "$InstallDir\venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
& "$InstallDir\venv\Scripts\pip.exe" install --quiet -r "$InstallDir\src\omnimesh\client\requirements.txt"

# --n-gpu-layers offloads all layers to GPU on the cuda/vulkan backends.
# NOTE: install.sh (Linux) does not currently set this flag despite
# selecting a cuda/vulkan build there too, which likely means Linux GPU
# nodes have been running CPU-only inference - a pre-existing gap this
# script does not silently inherit, but doesn't fix on the Linux side.
$GpuLayersArg = if ($Backend -ne "cpu") { "--n-gpu-layers 999" } else { "" }

Write-Host "--> Writing launcher scripts..."
@"
`$ErrorActionPreference = "Continue"
while (`$true) {
    & "$InstallDir\bin\llama-server.exe" --model "$ModelPath" --host 0.0.0.0 --port $LlamaPort --ctx-size $LlamaCtxSize --threads $LlamaThreads $GpuLayersArg *>> "$InstallDir\logs\llama.log"
    Add-Content "$InstallDir\logs\llama.log" "--- llama-server exited, restarting in 5s ---"
    Start-Sleep -Seconds 5
}
"@ | Set-Content -Encoding utf8 "$InstallDir\bin\start-llama.ps1"

@"
`$ErrorActionPreference = "Continue"
# No systemd-style After=/Requires= on Windows Scheduled Tasks - wait
# for llama-server's port directly instead.
while (-not (Test-NetConnection -ComputerName localhost -Port $LlamaPort -WarningAction SilentlyContinue -InformationLevel Quiet)) {
    Start-Sleep -Seconds 2
}
`$env:LLAMA_BASE_URL = "http://localhost:$LlamaPort"
`$env:HAMMER_LOG_DIR = "$InstallDir\logs"
while (`$true) {
    Push-Location "$InstallDir\src\omnimesh\client\engine"
    & "$InstallDir\venv\Scripts\uvicorn.exe" api:app --host 0.0.0.0 --port $HammerPort *>> "$InstallDir\logs\hammer.log"
    Pop-Location
    Add-Content "$InstallDir\logs\hammer.log" "--- hammer-api exited, restarting in 5s ---"
    Start-Sleep -Seconds 5
}
"@ | Set-Content -Encoding utf8 "$InstallDir\bin\start-hammer.ps1"

Write-Host "--> Writing hidden-launch wrappers..."
# -WindowStyle Hidden on powershell.exe is not reliably honored by
# Task Scheduler - notably, when Windows Terminal is the default
# terminal app (common on Win11), it opens a fully visible window
# anyway, ignoring that flag entirely. WScript.Shell.Run's window-style
# 0 bypasses PowerShell/Terminal's own window handling and is honored
# unconditionally, so it's the only reliably-invisible option here.
$PwshExe = (Get-Process -Id $PID).Path

@"
Set objShell = CreateObject("WScript.Shell")
objShell.Run """$PwshExe"" -NoProfile -WindowStyle Hidden -File ""$InstallDir\bin\start-llama.ps1""", 0, False
"@ | Set-Content -Encoding ascii "$InstallDir\bin\run-llama-hidden.vbs"

@"
Set objShell = CreateObject("WScript.Shell")
objShell.Run """$PwshExe"" -NoProfile -WindowStyle Hidden -File ""$InstallDir\bin\start-hammer.ps1""", 0, False
"@ | Set-Content -Encoding ascii "$InstallDir\bin\run-hammer-hidden.vbs"

Write-Host "--> Registering Scheduled Tasks (logon-triggered, no admin needed)..."

schtasks /Create /F /SC ONLOGON /RL LIMITED /TN "AnvilAI-Llama" `
    /TR "wscript.exe //B `"$InstallDir\bin\run-llama-hidden.vbs`"" | Out-Null

schtasks /Create /F /SC ONLOGON /RL LIMITED /TN "AnvilAI-Hammer" `
    /TR "wscript.exe //B `"$InstallDir\bin\run-hammer-hidden.vbs`"" | Out-Null

Write-Host "--> Starting services now (Scheduled Tasks only fire on next logon otherwise)..."
schtasks /Run /TN "AnvilAI-Llama" | Out-Null
Start-Sleep -Seconds 2
schtasks /Run /TN "AnvilAI-Hammer" | Out-Null

Write-Host "--> Done. hammer-api listening on http://localhost:$HammerPort"
Write-Host "    Status: Get-ScheduledTask AnvilAI-Llama, AnvilAI-Hammer"
Write-Host "    Logs:   $InstallDir\logs\llama.log, $InstallDir\logs\hammer.log"
