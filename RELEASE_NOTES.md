# OpenClaw Dashboard v3.0.2 - Security Review Follow-up

- Keep browser API access same-origin without reflecting request headers into
  CORS response headers.
- Resolve git from explicit system locations instead of relying on the process
  PATH. Use `DASHBOARD_GIT_BIN` with an absolute path for custom installations.
- Preserve the original atomic-write failure if closing or removing a temporary
  file also fails; cleanup cannot mask the actual write error.
- Quote the Docker healthcheck URL and add focused regression coverage for these
  security-review findings. All v3.0.1 security and pricing fixes are included.
- Preserve the legacy NVIDIA Kimi model alias for existing custom pricing files.

Upgrade by pulling the release and restarting, or rebuilding your Docker image.
There is no credential or session-data migration.

---

# OpenClaw Dashboard v3.0.1 - Security and Cost Accuracy

## Security fixes

- Escape session messages and metadata, git activity, cron names, model names,
  file names and previews before rendering. Preserve working action handlers
  without inserting untrusted text into executable JavaScript.
- Enforce fresh password/TOTP verification on the server for configuration and
  system-security endpoints. Grants are session-bound and expire after five
  minutes; failed verification and MFA changes invalidate existing grants.
- Run git activity commands with an argument array instead of a shell string.
- Persist recovery tokens in the private auth directory with owner-only file
  permissions. Never print token values to startup or service logs.
- Accept HTTPS forwarded headers only from loopback or explicitly trusted proxy
  addresses. Preserve configurable LAN, Tailscale and Docker bind behavior.
- Use the configured OpenClaw directory consistently for config access, and save
  configuration and backups atomically with private permissions.

## Cost accuracy

- Integrate PR #31 with provider-independent model aliases, provider prefixes,
  snapshot handling and explicit custom-price precedence. Fixes #30.
- Correct Opus 4.5/4.6 prices, add verified Claude generations, correct legacy
  OpenAI cache pricing and Gemini Flash text pricing. Addresses #40 using official
  provider sources rather than copying the proposed rates verbatim.
- Price explicit five-minute and one-hour Anthropic cache writes separately.
- Distinguish unpriced usage from free usage in sessions, model breakdowns and
  totals while retaining existing numeric API fields.
- Accumulate active and reset session files without overwriting session totals.

## Compatibility and validation

- Integrate PR #41 while retaining reachable Docker-published ports.
- Fix quick actions and cron requests under reverse-proxy subpaths.
- Test supported Node.js LTS versions 22, 24 and 26, plus a Docker build and
  published-port smoke test. Expand security, rendering and pricing regressions.
- Update install/recovery instructions, add the MIT license file, security
  reporting guidance and a reproducible bug-report template.

## Upgrade notes

Pull the release, restart the dashboard and refresh the browser. If building a
container, rebuild the image so the new `lib/` modules are included.

- No credential or agent-session migration is required. Preserve the auth/data
  directory and any existing `DASHBOARD_TOKEN` configuration.
- Find the generated recovery token in `$DASHBOARD_AUTH_DIR/recovery-token.txt`
  (default `$WORKSPACE_DIR/data/recovery-token.txt`), not in service logs.
- API clients reading configuration or system-security information must call
  `POST /api/reauth` in the same session first. Expired grants return
  `403 REAUTH_REQUIRED`; the dashboard handles this automatically.
- For a proxy on a separate host/container, set `DASHBOARD_TRUSTED_PROXIES` to its
  exact backend-facing IP and keep the backend port private. Native deployments
  can set `DASHBOARD_HOST=127.0.0.1`; containers retain `0.0.0.0` internally.
- Recomputed estimates may change when provider-reported positive costs are
  unavailable. Explicit custom rates and provider-reported costs remain primary.

---

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
