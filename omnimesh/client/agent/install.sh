#!/bin/bash
# Installs omnimesh-agent as a systemd service on this Linux node.
# Run from inside omnimesh/client/agent/ in a cloned copy of this repo:
#
#   sudo ./install.sh
#
# Builds from source (needs a Rust toolchain - rustup recommended, see
# omnimesh/client/scripts/install.sh for why the Debian-packaged rustc
# alone wasn't new enough here). There's no prebuilt-binary release
# pipeline for this agent yet, unlike llama.cpp's upstream releases
# used by that installer.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Writes to /opt and /etc/systemd/system - run with sudo." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/omnimesh-agent"
ENV_FILE="/etc/omnimesh-agent.env"

if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo not found. Install a Rust toolchain first (rustup.rs recommended)." >&2
    exit 1
fi

echo "--> Building release binary..."
cd "$SCRIPT_DIR"
sudo -u "${SUDO_USER:-root}" env HOME="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)" \
    bash -lc "cd '$SCRIPT_DIR' && cargo build --release"

mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/target/release/omnimesh-agent" "$INSTALL_DIR/omnimesh-agent"

if [ ! -f "$ENV_FILE" ]; then
    cp "$SCRIPT_DIR/omnimesh-agent.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "--> Wrote $ENV_FILE from the example. Edit it (HUB_URL, AGENT_TOKEN, NODE_NAME)"
    echo "    before the service will work against a real hub."
else
    echo "--> $ENV_FILE already exists, leaving it as-is."
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

echo "--> Installed. Edit $ENV_FILE if you haven't, then:"
echo "    systemctl start omnimesh-agent"
echo "    journalctl -u omnimesh-agent -f"
