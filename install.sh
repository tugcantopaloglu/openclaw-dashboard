#!/bin/bash
set -e

echo "🚀 OpenClaw Dashboard Installer"
echo "================================"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Please install a supported Node.js LTS release (v22+):"
  echo "   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -"
  echo "   sudo apt-get install -y nodejs"
  exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "❌ Node.js version is too old (need v22+, have v$NODE_VERSION)"
  exit 1
fi

echo "✅ Node.js $(node --version) detected"

# Check for jq (needed for Docker page)
if ! command -v jq &> /dev/null; then
  echo "⚠️  jq not found. Docker management page won't work without it."
  echo "   Install: sudo apt-get install -y jq"
fi

# Check for tmux (needed for Claude CLI usage scraper)
if ! command -v tmux &> /dev/null; then
  echo "⚠️  tmux not found. Claude CLI usage scraper won't work without it."
  echo "   Install: sudo apt-get install -y tmux"
fi

echo ""

# Detect workspace
if [ -z "$WORKSPACE_DIR" ]; then
  if [ -n "$OPENCLAW_WORKSPACE" ]; then
    WORKSPACE_DIR="$OPENCLAW_WORKSPACE"
  else
    read -p "Enter your OpenClaw workspace path (default: $HOME/clawd): " input
    WORKSPACE_DIR="${input:-$HOME/clawd}"
  fi
fi

if [ ! -d "$WORKSPACE_DIR" ]; then
  echo "⚠️  Workspace directory does not exist: $WORKSPACE_DIR"
  read -p "Create it now? (y/n): " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    mkdir -p "$WORKSPACE_DIR"
    echo "✅ Created workspace directory"
  else
    echo "❌ Installation cancelled"
    exit 1
  fi
fi

echo "✅ Workspace: $WORKSPACE_DIR"
echo ""

# Detect OpenClaw directory
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
if [ ! -d "$OPENCLAW_DIR" ]; then
  echo "⚠️  OpenClaw directory not found: $OPENCLAW_DIR"
  read -p "Continue anyway? (y/n): " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Installation cancelled"
    exit 1
  fi
fi

# Port selection
DASHBOARD_PORT="${DASHBOARD_PORT:-7000}"
read -p "Dashboard port (default: $DASHBOARD_PORT): " input
DASHBOARD_PORT="${input:-$DASHBOARD_PORT}"
DASHBOARD_HOST="${DASHBOARD_HOST:-0.0.0.0}"
DASHBOARD_AUTH_DIR="${DASHBOARD_AUTH_DIR:-$WORKSPACE_DIR/data}"

# Copy scraper scripts to workspace if not present
SCRIPTS_DIR="$WORKSPACE_DIR/scripts"
mkdir -p "$SCRIPTS_DIR"
if [ -f "$(pwd)/scripts/scrape-claude-usage.sh" ]; then
  if [ ! -f "$SCRIPTS_DIR/scrape-claude-usage.sh" ]; then
    cp "$(pwd)/scripts/scrape-claude-usage.sh" "$SCRIPTS_DIR/"
    cp "$(pwd)/scripts/parse-claude-usage.py" "$SCRIPTS_DIR/"
    chmod +x "$SCRIPTS_DIR/scrape-claude-usage.sh"
    echo "✅ Scraper scripts copied to $SCRIPTS_DIR"
  else
    echo "✅ Scraper scripts already exist in $SCRIPTS_DIR"
  fi
fi

echo ""
echo "📋 Installation Summary"
echo "----------------------"
echo "Workspace:     $WORKSPACE_DIR"
echo "OpenClaw Dir:  $OPENCLAW_DIR"
echo "Port:          $DASHBOARD_PORT"
echo "Install Dir:   $(pwd)"
echo ""
echo "🔐 Authentication"
echo "  On first visit, you'll create a username and password."
echo "  A recovery token will be saved privately in $DASHBOARD_AUTH_DIR/recovery-token.txt."
echo "  Optional: enable TOTP (2FA) from the Security page."
echo ""

read -p "Proceed with installation? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Installation cancelled"
  exit 1
fi

echo ""
echo "📦 Creating systemd service..."

SERVICE_FILE="/etc/systemd/system/agent-dashboard.service"
SERVICE_CONTENT="[Unit]
Description=OpenClaw Agent Dashboard
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=\"$(pwd)\"
ExecStart=\"$(which node)\" \"$(pwd)/server.js\"
Environment=DASHBOARD_PORT=$DASHBOARD_PORT
Environment=DASHBOARD_HOST=$DASHBOARD_HOST
Environment=\"WORKSPACE_DIR=$WORKSPACE_DIR\"
Environment=\"OPENCLAW_DIR=$OPENCLAW_DIR\"
Environment=\"DASHBOARD_AUTH_DIR=$DASHBOARD_AUTH_DIR\"
UMask=0077
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target"

if [ -w /etc/systemd/system ]; then
  echo "$SERVICE_CONTENT" > "$SERVICE_FILE"
else
  echo "$SERVICE_CONTENT" | sudo tee "$SERVICE_FILE" > /dev/null
fi

echo "✅ Service file created at $SERVICE_FILE"

# Reload systemd
sudo systemctl daemon-reload
echo "✅ Systemd reloaded"

# Enable service
sudo systemctl enable agent-dashboard
echo "✅ Service enabled (auto-start on boot)"

# Start service
sudo systemctl start agent-dashboard
echo "✅ Service started"

# Wait for startup
sleep 2

# Check status
if sudo systemctl is-active --quiet agent-dashboard; then
  echo ""
  echo "🎉 Installation successful!"
  echo ""
  echo "Dashboard is running at:"
  echo "  → http://localhost:$DASHBOARD_PORT"
  echo "  → http://$(hostname -I | awk '{print $1}'):$DASHBOARD_PORT"
  echo ""
  echo "🔐 First-time setup:"
  echo "  1. Open the dashboard URL above"
  echo "  2. Register a username and password"
  echo "  3. (Optional) Enable TOTP 2FA from the Security page"
  echo ""
  echo "🔑 Recovery token (for password reset):"
  echo "  Read the private file: $DASHBOARD_AUTH_DIR/recovery-token.txt"
  echo "  The token is never printed to service logs."
  echo ""
  echo "Useful commands:"
  echo "  sudo systemctl status agent-dashboard   # Check status"
  echo "  sudo systemctl restart agent-dashboard  # Restart"
  echo "  sudo systemctl stop agent-dashboard     # Stop"
  echo "  journalctl -u agent-dashboard -f        # View logs"
  echo ""
else
  echo ""
  echo "❌ Service failed to start. Check logs:"
  echo "  journalctl -u agent-dashboard -n 50"
  exit 1
fi
