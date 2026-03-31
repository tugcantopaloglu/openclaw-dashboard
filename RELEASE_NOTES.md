# OpenClaw Dashboard v3.0.0 - Release Notes

## 🎨 UI & Theming

### 🌙 Dark/Light Theme Toggle
- One-click toggle button (top-right, next to notification bell)
- Comprehensive CSS overrides for all cards, inputs, sidebar, modals
- Persistent preference via localStorage
- Light theme with clean white cards, subtle shadows, and adjusted text colors

### 📱 Crash Counter Labels
- Crash widget now clearly labeled with "💥 Crashes" header
- "today" and "7-day" labels next to values for clarity

### 📋 Memory Files Collapse
- Overview memory files limited to 5 items by default
- "Show all (X files) ↓" button expands the full list

## 🛡️ Security & System

### 🛡️ System Security Dashboard
- New "Sys Security" page in sidebar
- 5 panels: UFW rules, open ports, fail2ban status, SSH login logs, OpenClaw audit
- **Re-authentication required** — password + TOTP before access
- All command outputs HTML-escaped to prevent XSS

### ⚙️ Config Editor
- Edit `openclaw.json` directly from the dashboard
- Client-side JSON validation before save
- Automatic `.bak.timestamp` backup before overwriting
- Gateway restart after save with confirmation dialog
- **Re-authentication required**

### 🔒 Re-authentication Gate
- Security, Sys Security, and Config Editor pages require password + TOTP re-verification
- One verification per browser session
- Uses existing `verifyPassword()` and `verifyTOTP()` functions
- Failed attempts logged to audit trail

## 🐳 Docker Management
- New "Docker" page in sidebar
- Container list with status indicators (🟢/🔴), image, ports
- Start/Stop/Restart buttons per container with confirmation
- Image list with repository, tag, and size
- `docker system df` overview
- Prune stopped containers and unused images
- Container ID validation: only `[a-zA-Z0-9_.-]` accepted (injection protection)
- Whitelisted actions only: `start`, `stop`, `restart`, `prune-containers`, `prune-images`

## 🔔 Notification Center
- Bell icon opens dropdown panel with recent audit log events
- Event types: login, logout, reauth, config changes, docker actions, security views
- Icons per event type for quick scanning
- Unread badge counter with 30-second polling
- Click outside to dismiss panel
- Last-seen timestamp persisted in localStorage

## 📊 System Monitoring

### Temperature & Disk Sparklines
- TEMP and DISK gauges now have mini history graphs (like CPU and RAM)
- Health history saves `temp` and `disk` values every 5 minutes
- 24-hour data retention (288 snapshots)

## 🔧 Infrastructure

### Claude CLI Usage Scraper
- `scripts/scrape-claude-usage.sh` and `scripts/parse-claude-usage.py` included in repo
- Uses persistent tmux session for fast scraping
- Lock file prevents concurrent runs
- Fixed: `/usage` command typed fully instead of `/u` + autocomplete (Claude CLI v2.1.69 change)

### install.sh Updates
- Removed token-based auth references (dashboard uses username/password now)
- Added `jq` and `tmux` dependency checks
- Copies scraper scripts to workspace during install
- Updated first-time setup instructions

### Documentation
- README updated with all new features and API endpoints
- Optional dependencies table added
- "No External Dependencies" updated to "Minimal Dependencies"
- 10 new API endpoints documented

## 🆕 New API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/reauth` | POST | Re-authenticate for sensitive pages |
| `/api/openclaw-config` | GET | Read OpenClaw configuration |
| `/api/openclaw-config` | PUT | Save config with backup + restart |
| `/api/sys-security` | GET | UFW, ports, fail2ban, SSH logs |
| `/api/docker` | GET | Containers, images, system usage |
| `/api/docker/action` | POST | Container/image actions |
| `/api/services` | GET | List systemd services |
| `/api/services/action` | POST | Start/stop/restart services |
| `/api/notifications` | GET | Audit log events |

## ⬆️ Upgrade from v2.x

1. Pull latest: `git pull origin main`
2. Install optional dependencies: `sudo apt install jq tmux`
3. Restart service: `systemctl restart agent-dashboard`
4. New pages appear automatically in sidebar
5. Clear browser cache if theme toggle doesn't appear (`Ctrl+Shift+R`)

---

*Previous versions:*
- *[v2.0.0 — Authentication & Security Hardening](#v200)*
- *[v1.0.0 — Initial Public Release](#v100)*

---

# OpenClaw Dashboard v2.0.0 - Release Notes

## 🔐 Authentication & Security Hardening

Major security release — the dashboard now requires authentication and includes enterprise-grade security features.

### 🆕 New Features

- 🔑 Username/Password Authentication with PBKDF2 hashing
- 🛡️ Multi-Factor Authentication (TOTP)
- 🔒 Password Recovery via recovery token
- 🌐 HTTPS Enforcement for non-localhost connections
- Security headers (HSTS, CSP, X-Frame-Options, etc.)
- Rate limiting (5 soft / 20 hard lockout)
- Audit logging with auto-rotation

See git history for full v2.0.0 details.

---

# OpenClaw Dashboard v1.0.0

Initial public release with session management, cost analysis, live feed, memory viewer, system health monitoring, and more.
