#!/bin/bash
# AnvilAI standalone installer (Linux).
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/Nvmdfth/AnvilAI/main/omnimesh/client/scripts/install.sh | sudo bash
#
# Installs a prebuilt llama-server (GPU backend if detected, else CPU),
# the default model, and hammer-api, all as system-level systemd
# services under /opt/anvilai. No Docker required. Requires root (writes
# to /opt and /etc/systemd/system).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "This installer writes to /opt and /etc/systemd/system - run with sudo." >&2
    exit 1
fi

INSTALL_DIR="/opt/anvilai"
REPO_URL="https://github.com/Nvmdfth/AnvilAI.git"

# Pinned llama.cpp release build. llama.cpp publishes many builds a day
# under non-semver tags (b#####) rather than a stable "latest" release;
# bump this deliberately after testing a newer tag, don't chase HEAD.
LLAMA_RELEASE_TAG="b11232"

MODEL_URL="https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"
MODEL_FILE="qwen2.5-1.5b-instruct-q4_k_m.gguf"

LLAMA_THREADS="${LLAMA_THREADS:-3}"
LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-4096}"
LLAMA_PORT="${LLAMA_PORT:-8080}"
HAMMER_PORT="${HAMMER_PORT:-8001}"

echo "--> Detecting OS/architecture..."
if [ "$(uname -s)" != "Linux" ]; then
    echo "This installer is for Linux. Use install.ps1 on Windows." >&2
    exit 1
fi

case "$(uname -m)" in
    x86_64) LLAMA_ARCH="x64" ;;
    aarch64) LLAMA_ARCH="arm64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

echo "--> Detecting GPU..."
BACKEND="cpu"
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    BACKEND="cuda"
elif command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q libvulkan.so; then
    BACKEND="vulkan"
fi
echo "--> Backend: $BACKEND ($LLAMA_ARCH)"

case "$BACKEND" in
    cpu)    ASSET="llama-${LLAMA_RELEASE_TAG}-bin-ubuntu-${LLAMA_ARCH}.tar.gz" ;;
    cuda)   ASSET="llama-${LLAMA_RELEASE_TAG}-bin-ubuntu-cuda-12.8-${LLAMA_ARCH}.tar.gz" ;;
    vulkan) ASSET="llama-${LLAMA_RELEASE_TAG}-bin-ubuntu-vulkan-${LLAMA_ARCH}.tar.gz" ;;
esac
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/${ASSET}"

mkdir -p "$INSTALL_DIR"/{bin,models,logs}

echo "--> Downloading llama.cpp ($ASSET)..."
TMP_TAR=$(mktemp)
curl -sSL -o "$TMP_TAR" "$LLAMA_URL"
tar -xzf "$TMP_TAR" -C "$INSTALL_DIR/bin" --strip-components=1
rm -f "$TMP_TAR"

if [ ! -f "$INSTALL_DIR/models/$MODEL_FILE" ]; then
    echo "--> Downloading default model (~1.1GB)..."
    curl -sSL -o "$INSTALL_DIR/models/$MODEL_FILE.part" "$MODEL_URL"
    mv "$INSTALL_DIR/models/$MODEL_FILE.part" "$INSTALL_DIR/models/$MODEL_FILE"
else
    echo "--> Model already present, skipping download."
fi

echo "--> Fetching AnvilAI source..."
if [ -d "$INSTALL_DIR/src/.git" ]; then
    git -C "$INSTALL_DIR/src" pull --quiet
else
    rm -rf "$INSTALL_DIR/src"
    git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR/src"
fi

echo "--> Setting up hammer-api virtualenv..."
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install --quiet -r "$INSTALL_DIR/src/omnimesh/client/requirements.txt"

echo "--> Writing systemd units..."
cat > /etc/systemd/system/anvilai-llama.service <<EOF
[Unit]
Description=AnvilAI llama-server
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR/bin
Environment=LD_LIBRARY_PATH=$INSTALL_DIR/bin
ExecStart=$INSTALL_DIR/bin/llama-server --model $INSTALL_DIR/models/$MODEL_FILE --host 0.0.0.0 --port $LLAMA_PORT --ctx-size $LLAMA_CTX_SIZE --threads $LLAMA_THREADS
Restart=always
RestartSec=5
User=nobody

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/anvilai-hammer.service <<EOF
[Unit]
Description=AnvilAI hammer-api
After=anvilai-llama.service
Requires=anvilai-llama.service

[Service]
WorkingDirectory=$INSTALL_DIR/src/omnimesh/client/engine
Environment=LLAMA_BASE_URL=http://localhost:$LLAMA_PORT
Environment=HAMMER_LOG_DIR=$INSTALL_DIR/logs
ExecStart=$INSTALL_DIR/venv/bin/uvicorn api:app --host 0.0.0.0 --port $HAMMER_PORT
Restart=always
RestartSec=5
User=nobody

[Install]
WantedBy=multi-user.target
EOF

chown -R nobody:nogroup "$INSTALL_DIR"

systemctl daemon-reload
systemctl enable --now anvilai-llama.service
systemctl enable --now anvilai-hammer.service

echo "--> Done. hammer-api listening on http://localhost:$HAMMER_PORT"
echo "    Status: systemctl status anvilai-llama anvilai-hammer"
echo "    Logs:   journalctl -u anvilai-llama -u anvilai-hammer -f"
