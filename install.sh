#!/bin/bash
set -e

echo "🚀 OpenClaw Dashboard Installer"
echo "================================"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Please install Node.js v18+ first:"
  echo "   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
  echo "   sudo apt-get install -y nodejs"
  exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js version is too old (need v18+, have v$NODE_VERSION)"
  exit 1
fi

echo "✅ Node.js $(node --version) detected"
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

# Token setup
if [ -z "$DASHBOARD_TOKEN" ]; then
  echo ""
  echo "🔐 Authentication Setup"
  echo "  A token is required to access the dashboard."
  echo "  Leave blank to auto-generate a random 32-char token."
  read -p "Dashboard token (leave blank for auto): " input
  if [ -n "$input" ]; then
    DASHBOARD_TOKEN="$input"
    echo "✅ Using provided token"
  else
    DASHBOARD_TOKEN=$(openssl rand -hex 16 2>/dev/null || node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
    echo "✅ Auto-generated token: $DASHBOARD_TOKEN"
    echo "   ⚠️  Save this token! You'll need it to log in."
  fi
fi

echo ""
echo "📋 Installation Summary"
echo "----------------------"
echo "Workspace:     $WORKSPACE_DIR"
echo "OpenClaw Dir:  $OPENCLAW_DIR"
echo "Port:          $DASHBOARD_PORT"
echo "Token:         ${DASHBOARD_TOKEN:0:8}..."
echo "Install Dir:   $(pwd)"
echo ""

read -p "Proceed with installation? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Installation cancelled"
  exit 1
fi

echo ""
echo "📦 Creating systemd user service..."

# Use user-level systemd (no sudo required)
SERVICE_DIR="$HOME/.config/systemd/user"
mkdir -p "$SERVICE_DIR"
SERVICE_FILE="$SERVICE_DIR/agent-dashboard.service"

SERVICE_CONTENT="[Unit]
Description=OpenClaw Agent Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$(pwd)
ExecStart=$(which node) $(pwd)/server.js
Environment=DASHBOARD_PORT=$DASHBOARD_PORT
Environment=DASHBOARD_TOKEN=$DASHBOARD_TOKEN
Environment=WORKSPACE_DIR=$WORKSPACE_DIR
Environment=OPENCLAW_DIR=$OPENCLAW_DIR
Restart=always
RestartSec=5

[Install]
WantedBy=default.target"

echo "$SERVICE_CONTENT" > "$SERVICE_FILE"
echo "✅ Service file created at $SERVICE_FILE"

# Migrate from system-level service if it exists
SYSTEM_SERVICE="/etc/systemd/system/agent-dashboard.service"
if [ -f "$SYSTEM_SERVICE" ]; then
  echo "⚠️  Found old system-level service at $SYSTEM_SERVICE"
  echo "   Migrating to user-level service (no sudo needed for management)."
  if sudo -n systemctl stop agent-dashboard 2>/dev/null; then
    sudo -n systemctl disable agent-dashboard 2>/dev/null
    echo "✅ Old system service stopped and disabled"
  else
    echo "   Run manually: sudo systemctl stop agent-dashboard && sudo systemctl disable agent-dashboard"
  fi
fi

# Enable lingering so user services survive logout
if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
  if loginctl enable-linger "$USER" 2>/dev/null; then
    echo "✅ Lingering enabled (service persists after logout)"
  elif sudo -n loginctl enable-linger "$USER" 2>/dev/null; then
    echo "✅ Lingering enabled (service persists after logout)"
  else
    echo "⚠️  Could not enable lingering. Run: sudo loginctl enable-linger $USER"
  fi
fi

# Reload systemd user daemon
systemctl --user daemon-reload
echo "✅ Systemd user daemon reloaded"

# Enable service
systemctl --user enable agent-dashboard
echo "✅ Service enabled (auto-start on boot)"

# Start service
systemctl --user start agent-dashboard
echo "✅ Service started"

# Wait a moment for the service to start
sleep 2

# Check status
if systemctl --user is-active --quiet agent-dashboard; then
  echo ""
  echo "🎉 Installation successful!"
  echo ""
  echo "Dashboard is running at:"
  echo "  → http://localhost:$DASHBOARD_PORT"
  echo "  → http://$(hostname -I | awk '{print $1}'):$DASHBOARD_PORT"
  echo ""
  echo "🔐 Login token: $DASHBOARD_TOKEN"
  echo "   To enable MFA: Log in → Security page → Enable MFA"
  echo ""
  echo "Useful commands:"
  echo "  systemctl --user status agent-dashboard   # Check status"
  echo "  systemctl --user restart agent-dashboard  # Restart"
  echo "  systemctl --user stop agent-dashboard     # Stop"
  echo "  journalctl --user -u agent-dashboard -f   # View logs"
  echo ""
else
  echo ""
  echo "❌ Service failed to start. Check logs:"
  echo "  journalctl --user -u agent-dashboard -n 50"
  exit 1
fi
