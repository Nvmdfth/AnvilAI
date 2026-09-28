#!/bin/bash
# Installs omnimesh-agent as a systemd service on this Linux node.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/Nvmdfth/AnvilAI/main/omnimesh/client/agent/install.sh | sudo bash
#
# Pass HUB_URL/AGENT_TOKEN/NODE_NAME as env vars on the sudo command
# itself (not before the pipe - sudo drops the caller's environment
# unless the vars are named directly on its command line):
#
#   curl -sSL .../install.sh | sudo HUB_URL=http://hub:4000 AGENT_TOKEN=xxx NODE_NAME=my-node bash
#
# Re-running (e.g. to change AGENT_TOKEN later) updates /etc/omnimesh-agent.env
# in place and restarts the service if it's already running; any var left
# unset keeps its previously-written value instead of resetting to the
# built-in default.
#
# Builds from source (needs a Rust toolchain - rustup recommended, see
# omnimesh/client/scripts/install.sh for why the Debian-packaged rustc
# alone wasn't new enough here). There's no prebuilt-binary release
# pipeline for this agent yet, unlike llama.cpp's upstream releases used
# by that installer.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Writes to /opt and /etc/systemd/system - run with sudo." >&2
    exit 1
fi

INSTALL_DIR="/opt/omnimesh-agent"
ENV_FILE="/etc/omnimesh-agent.env"
REPO_URL="https://github.com/Nvmdfth/AnvilAI.git"
AGENT_SRC_DIR="$INSTALL_DIR/src/omnimesh/client/agent"

if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo not found. Install a Rust toolchain first (rustup.rs recommended)." >&2
    exit 1
fi

mkdir -p "$INSTALL_DIR"

echo "--> Fetching AnvilAI source..."
if [ -d "$INSTALL_DIR/src/.git" ]; then
    git -C "$INSTALL_DIR/src" pull --quiet
else
    rm -rf "$INSTALL_DIR/src"
    git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR/src"
fi

echo "--> Building release binary..."
sudo -u "${SUDO_USER:-root}" env HOME="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)" \
    bash -lc "cd '$AGENT_SRC_DIR' && cargo build --release"

cp "$AGENT_SRC_DIR/target/release/omnimesh-agent" "$INSTALL_DIR/omnimesh-agent"

# Pull forward whatever's already on disk from a prior install so a
# re-run only touches the vars the caller actually passed this time.
existing_value() {
    if [ -f "$ENV_FILE" ]; then
        sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1
    fi
}

HUB_URL="${HUB_URL:-$(existing_value HUB_URL)}"
HUB_URL="${HUB_URL:-http://localhost:4000}"

AGENT_TOKEN="${AGENT_TOKEN:-$(existing_value AGENT_TOKEN)}"
AGENT_TOKEN="${AGENT_TOKEN:-change-me-to-match-the-hub}"

NODE_NAME="${NODE_NAME:-$(existing_value NODE_NAME)}"

LOCAL_LLAMA_URL="${LOCAL_LLAMA_URL:-$(existing_value LOCAL_LLAMA_URL)}"
LOCAL_LLAMA_URL="${LOCAL_LLAMA_URL:-http://localhost:8080}"

LOCAL_HAMMER_API="${LOCAL_HAMMER_API:-$(existing_value LOCAL_HAMMER_API)}"
LOCAL_HAMMER_API="${LOCAL_HAMMER_API:-http://localhost:8001}"

CAPABILITY="${CAPABILITY:-$(existing_value CAPABILITY)}"
CAPABILITY="${CAPABILITY:-llm_generation}"

POLL_INTERVAL_SECS="${POLL_INTERVAL_SECS:-$(existing_value POLL_INTERVAL_SECS)}"
POLL_INTERVAL_SECS="${POLL_INTERVAL_SECS:-3}"

cat > "$ENV_FILE" <<EOF
HUB_URL=$HUB_URL
AGENT_TOKEN=$AGENT_TOKEN
NODE_NAME=$NODE_NAME
LOCAL_LLAMA_URL=$LOCAL_LLAMA_URL
LOCAL_HAMMER_API=$LOCAL_HAMMER_API
CAPABILITY=$CAPABILITY
POLL_INTERVAL_SECS=$POLL_INTERVAL_SECS
EOF
chmod 600 "$ENV_FILE"

if [ "$AGENT_TOKEN" = "change-me-to-match-the-hub" ]; then
    echo "--> Wrote $ENV_FILE with a placeholder AGENT_TOKEN - re-run with"
    echo "    AGENT_TOKEN=<matches the hub's> (see usage at the top of this script)"
    echo "    or edit $ENV_FILE directly before starting the service."
else
    echo "--> Wrote $ENV_FILE (HUB_URL=$HUB_URL)."
fi

cat > /etc/systemd/system/omnimesh-agent.service <<EOF
[Unit]
Description=OmniMesh worker agent
After=network.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=$INSTALL_DIR/omnimesh-agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable omnimesh-agent

if systemctl is-active --quiet omnimesh-agent; then
    echo "--> Restarting omnimesh-agent to pick up the new config..."
    systemctl restart omnimesh-agent
    echo "--> Done. journalctl -u omnimesh-agent -f"
else
    echo "--> Installed. Start it with:"
    echo "    systemctl start omnimesh-agent"
    echo "    journalctl -u omnimesh-agent -f"
fi
