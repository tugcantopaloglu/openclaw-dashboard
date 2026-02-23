const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// Configuration via environment variables
const PORT = parseInt(process.env.DASHBOARD_PORT || '7000');
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.env.OPENCLAW_WORKSPACE || process.cwd();
const AGENT_ID = process.env.OPENCLAW_AGENT || 'main';
const sessDir = path.join(OPENCLAW_DIR, 'agents', AGENT_ID, 'sessions');
const claudeCliDir = path.join(os.homedir(), '.claude', 'projects');
const cronFile = path.join(OPENCLAW_DIR, 'cron', 'jobs.json');
const antfarmDbPath = path.join(OPENCLAW_DIR, 'antfarm', 'antfarm.db');
const dataDir = path.join(WORKSPACE_DIR, 'data');
const chatLogsDir = path.join(dataDir, 'chat-logs');
const memoryDir = path.join(WORKSPACE_DIR, 'memory');
const memoryMdPath = path.join(WORKSPACE_DIR, 'MEMORY.md');
const heartbeatPath = path.join(WORKSPACE_DIR, 'HEARTBEAT.md');
const healthHistoryFile = path.join(dataDir, 'health-history.json');
const claudeUsageFile = path.join(dataDir, 'claude-usage.json');
const scrapeScript = path.join(WORKSPACE_DIR, 'scripts', 'scrape-claude-usage.sh');

const htmlPath = path.join(__dirname, 'index.html');
const chatFile = path.join(dataDir, 'chat-messages.json');
const chatCommandFile = path.join(dataDir, 'chat-command.txt');
const CHAT_TOKEN = process.env.CHAT_TOKEN || '';
const DOCBOT_TOKEN = process.env.DOCBOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const AUTH_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const AUTH_ENABLED = process.env.DASHBOARD_AUTH !== 'false';
const authSessions = new Map();

function generateSessionToken() { return crypto.randomBytes(32).toString('hex'); }
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => { const [k, v] = c.trim().split('='); if (k && v) cookies[k] = v; });
  return cookies;
}
function isAuthenticated(req) {
  if (!AUTH_ENABLED) return true;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['dash_session'];
  if (token && authSessions.has(token)) {
    const session = authSessions.get(token);
    if (Date.now() - session.created < 7 * 86400000) return true;
    authSessions.delete(token);
  }
  return false;
}
const loginPage = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Login - Dashboard</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',-apple-system,sans-serif;background:#0a0a0f;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login{background:#1f1f2e;border:1px solid #2a2a3a;border-radius:16px;padding:40px;width:90%;max-width:380px;text-align:center}
h1{font-size:28px;margin-bottom:8px;background:linear-gradient(135deg,#e4e4e7,#6366f1);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
p{color:#a1a1aa;font-size:14px;margin-bottom:24px}
input{width:100%;padding:12px 16px;background:#13131a;color:#e4e4e7;border:1px solid #2a2a3a;border-radius:12px;font-size:16px;outline:none;margin-bottom:16px}
input:focus{border-color:#6366f1}
button{width:100%;padding:12px;background:linear-gradient(135deg,#6366f1,#a855f7);color:white;border:none;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer}
button:hover{opacity:0.9}.error{color:#ef4444;font-size:13px;margin-bottom:12px;display:none}</style></head>
<body><div class="login"><h1>OpenClaw</h1><p>Dashboard Login</p>
<div class="error" id="err">Incorrect password</div>
<form onsubmit="return doLogin(event)"><input type="password" id="pw" placeholder="Password" autofocus>
<button type="submit">Login</button></form></div>
<script>function doLogin(e){e.preventDefault();fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})}).then(r=>r.json()).then(d=>{if(d.ok)location.reload();else{document.getElementById('err').style.display='block';document.getElementById('pw').value='';}}).catch(()=>document.getElementById('err').style.display='block');return false;}</script></body></html>`;

// Ensure data directory exists
try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}

function getGitRepos() {
  const repos = [];
  const projDir = path.join(WORKSPACE_DIR, 'projects');
  try {
    if (fs.existsSync(projDir)) {
      fs.readdirSync(projDir).forEach(d => {
        const full = path.join(projDir, d);
        if (fs.existsSync(path.join(full, '.git'))) repos.push({ path: full, name: d });
      });
    }
  } catch {}
  // Also check workspace root
  if (fs.existsSync(path.join(WORKSPACE_DIR, '.git'))) repos.push({ path: WORKSPACE_DIR, name: path.basename(WORKSPACE_DIR) });
  return repos;
}

function resolveName(key) {
  if (key.includes(':main:main')) return 'main';
  if (key.includes('teleg')) return 'telegram-group';
  if (key.includes('cron:')) {
    try {
      if (fs.existsSync(cronFile)) {
        const crons = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
        const jobs = crons.jobs || [];
        // Extract the cron UUID from the key (after "cron:")
        const cronPart = key.split('cron:')[1] || '';
        const cronUuid = cronPart.split(':')[0]; // get just the UUID, not :run:xxx
        const job = jobs.find(j => j.id === cronUuid);
        if (job && job.name) return job.name;
      }
    } catch {}
    // Extract short ID for fallback
    const cronPart = key.split('cron:')[1] || '';
    const cronUuid = cronPart.split(':')[0];
    return 'Cron: ' + cronUuid.substring(0, 8);
  }
  if (key.includes('subagent')) {
    const parts = key.split(':');
    return parts[parts.length - 1].substring(0, 12);
  }
  return key.split(':').pop().substring(0, 12);
}

function getLastMessage(sessionId) {
  try {
    const filePath = path.join(sessDir, sessionId + '.jsonl');
    if (!fs.existsSync(filePath)) return '';
    const data = fs.readFileSync(filePath, 'utf8');
    const lines = data.split('\n').filter(l => l.trim());
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.type !== 'message') continue;
        const msg = d.message;
        if (!msg) continue;
        const role = msg.role;
        if (role !== 'user' && role !== 'assistant') continue;
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === 'text' && b.text) { text = b.text; break; }
          }
        }
        if (text) return text.replace(/\n/g, ' ').substring(0, 80);
      } catch {}
    }
    return '';
  } catch { return ''; }
}

let sessionCostCache = {};
let sessionCostCacheTime = 0;

function getSessionCost(sessionId) {
  const now = Date.now();
  if (now - sessionCostCacheTime > 60000) {
    sessionCostCache = {};
    sessionCostCacheTime = now;
    try {
      const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const sid = file.replace('.jsonl', '');
        let total = 0;
        const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type !== 'message') continue;
            const c = d.message?.usage?.cost?.total || 0;
            if (c > 0) total += c;
          } catch {}
        }
        if (total > 0) sessionCostCache[sid] = Math.round(total * 100) / 100;
      }
    } catch {}
  }
  return sessionCostCache[sessionId] || 0;
}

function getSessionsJson() {
  try {
    const sFile = path.join(sessDir, 'sessions.json');
    const data = JSON.parse(fs.readFileSync(sFile, 'utf8'));
    return Object.entries(data).map(([key, s]) => ({
      key,
      label: s.label || resolveName(key),
      model: s.modelOverride || s.model || '-',
      totalTokens: s.totalTokens || 0,
      contextTokens: s.contextTokens || 0,
      kind: s.kind || (key.includes('group') ? 'group' : 'direct'),
      updatedAt: s.updatedAt || 0,
      createdAt: s.createdAt || s.updatedAt || 0,
      aborted: s.abortedLastRun || false,
      thinkingLevel: s.thinkingLevel || null,
      channel: s.channel || '-',
      sessionId: s.sessionId || '-',
      lastMessage: getLastMessage(s.sessionId || key),
      cost: getSessionCost(s.sessionId || key)
    }));
  } catch (e) { return []; }
}

// Pricing per 1M tokens (Claude API pricing)
const MODEL_PRICING = {
  opus:   { input: 15, output: 75, cache: 1.875 },
  sonnet: { input: 3, output: 15, cache: 0.375 },
  haiku:  { input: 0.25, output: 1.25, cache: 0.03 }
};

function getModelPricing(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('opus')) return MODEL_PRICING.opus;
  if (m.includes('sonnet')) return MODEL_PRICING.sonnet;
  if (m.includes('haiku')) return MODEL_PRICING.haiku;
  return null;
}

// Normalize usage fields from Claude CLI format (input_tokens) to dashboard format (input)
function normalizeUsage(msg) {
  const u = msg.usage;
  if (!u) return null;
  // Claude CLI format uses input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens
  // OpenClaw format uses input/output/cacheRead/cacheWrite
  const input = u.input || u.input_tokens || 0;
  const output = u.output || u.output_tokens || 0;
  const cacheRead = u.cacheRead || u.cache_read_input_tokens || 0;
  const cacheWrite = u.cacheWrite || u.cache_creation_input_tokens || 0;
  // Cost: use explicit cost if available, otherwise estimate from tokens
  let cost = 0;
  if (u.cost && u.cost.total) {
    cost = u.cost.total;
  } else {
    const pricing = getModelPricing(msg.model);
    if (pricing) {
      cost = (input / 1e6 * pricing.input) + (output / 1e6 * pricing.output) + ((cacheRead + cacheWrite) / 1e6 * pricing.cache);
    }
  }
  return { input: input + cacheRead + cacheWrite, output, cost, cacheRead, cacheWrite, rawInput: input };
}

// Collect all JSONL session files from both OpenClaw and Claude CLI directories
function getAllSessionFiles(maxAgeDays) {
  const result = []; // { filePath, sessionId }
  const cutoff = maxAgeDays ? Date.now() - maxAgeDays * 86400000 : 0;
  // 1. OpenClaw sessions
  try {
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const fp = path.join(sessDir, f);
      try {
        if (cutoff && fs.statSync(fp).mtimeMs < cutoff) continue;
        result.push({ filePath: fp, sessionId: f.replace('.jsonl', ''), source: 'openclaw' });
      } catch {}
    }
  } catch {}
  // 2. Claude CLI sessions (main project dirs, skip antfarm temp dirs for performance)
  try {
    const dirs = fs.readdirSync(claudeCliDir).filter(d => {
      // Include main project dirs, skip tmp-antfarm-work dirs (too many, stale)
      return !d.startsWith('-tmp-antfarm-work') && fs.statSync(path.join(claudeCliDir, d)).isDirectory();
    });
    for (const dir of dirs) {
      const dirPath = path.join(claudeCliDir, dir);
      try {
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const fp = path.join(dirPath, f);
          try {
            if (cutoff && fs.statSync(fp).mtimeMs < cutoff) continue;
            result.push({ filePath: fp, sessionId: f.replace('.jsonl', ''), source: 'claude-cli', project: dir });
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return result;
}

function getCostData() {
  try {
    const sessionFiles = getAllSessionFiles(30); // last 30 days
    const perModel = {};
    const perDay = {};
    const perSession = {};
    let total = 0;

    for (const { filePath, sessionId } of sessionFiles) {
      let scost = 0;
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'message' && d.type !== 'assistant') continue;
          const msg = d.message || d;
          if (!msg || !msg.usage) continue;
          const model = msg.model || 'unknown';
          if (model.includes('delivery-mirror')) continue;
          const norm = normalizeUsage(msg);
          if (!norm || norm.cost <= 0) continue;
          const c = norm.cost;
          const ts = d.timestamp || '';
          const day = ts.substring(0, 10);
          perModel[model] = (perModel[model] || 0) + c;
          if (day) perDay[day] = (perDay[day] || 0) + c;
          scost += c;
          total += c;
        } catch {}
      }
      if (scost > 0) perSession[sessionId] = scost;
    }

    const now = new Date();
    const todayKey = now.toISOString().substring(0, 10);
    const weekAgo = new Date(now - 7 * 86400000).toISOString().substring(0, 10);
    let weekCost = 0;
    for (const [d, c] of Object.entries(perDay)) {
      if (d >= weekAgo) weekCost += c;
    }

    return {
      total: Math.round(total * 100) / 100,
      today: Math.round((perDay[todayKey] || 0) * 100) / 100,
      week: Math.round(weekCost * 100) / 100,
      perModel,
      perDay: Object.fromEntries(Object.entries(perDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14)),
      perSession: (() => {
        let sidLabels = {};
        try {
          const sData = JSON.parse(fs.readFileSync(path.join(sessDir, 'sessions.json'), 'utf8'));
          for (const [key, val] of Object.entries(sData)) {
            if (val.sessionId) sidLabels[val.sessionId] = val.label || key.split(':').slice(2).join(':');
          }
        } catch {}
        return Object.fromEntries(
          Object.entries(perSession).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([sid, cost]) => {
            let label = sidLabels[sid] || null;
            if (!label) {
              try {
                const jf = path.join(sessDir, sid + '.jsonl');
                if (!fs.existsSync(jf)) {
                  const del = fs.readdirSync(sessDir).find(f => f.startsWith(sid) && f.includes('.deleted'));
                  if (del) { /* deleted session, no label */ }
                }
                if (fs.existsSync(jf)) {
                  const lines = fs.readFileSync(jf, 'utf8').split('\n');
                  for (const l of lines) {
                    if (!l.includes('"user"')) continue;
                    try {
                      const d = JSON.parse(l);
                      const c = d.message?.content;
                      const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.find(x => x.type === 'text')?.text || '' : '';
                      if (txt) {
                        let t = txt.replace(/\n/g, ' ').trim();
                        const bgMatch = t.match(/background task "([^"]+)"/i);
                        if (bgMatch) t = 'Sub: ' + bgMatch[1];
                        const cronMatch = t.match(/\[cron:([^\]]+)\]/);
                        if (cronMatch) {
                          let cronName = cronMatch[1].substring(0, 8);
                          try {
                            const cj = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
                            const job = cj.jobs?.find(j => j.id?.startsWith(cronMatch[1].substring(0, 8)));
                            if (job?.name) cronName = job.name;
                          } catch {}
                          t = 'Cron: ' + cronName;
                        }
                        if (t.startsWith('System:')) t = t.substring(7).trim();
                        t = t.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, '');
                        if (t.startsWith('You are running a boot')) t = 'Boot check';
                        if (t.match(/whatsapp/i)) t = 'WhatsApp session';
                        const subMatch2 = t.match(/background task "([^"]+)"/i);
                        if (!bgMatch && subMatch2) t = 'Sub: ' + subMatch2[1];
                        label = t.substring(0, 35); if (t.length > 35) label += '…';
                        break;
                      }
                    } catch {}
                  }
                }
              } catch {}
            }
            return [sid, { cost, label: label || ('session-' + sid.substring(0, 8)) }];
          })
        );
      })()
    };
  } catch (e) { return { total: 0, today: 0, week: 0, perModel: {}, perDay: {}, perSession: {} }; }
}

let costCache = null;
let costCacheTime = 0;

function getUsageWindows() {
  try {
    const now = Date.now();
    const fiveHoursMs = 5 * 3600000;
    const oneWeekMs = 7 * 86400000;
    const sessionFiles = getAllSessionFiles(7); // last 7 days

    const perModel5h = {};
    const perModelWeek = {};
    const recentMessages = [];

    for (const { filePath } of sessionFiles) {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'message' && d.type !== 'assistant') continue;
          const msg = d.message || d;
          if (!msg || !msg.usage) continue;
          const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
          if (!ts) continue;
          const model = msg.model || 'unknown';
          if (model.includes('delivery-mirror')) continue;
          const norm = normalizeUsage(msg);
          if (!norm) continue;

          if (now - ts < fiveHoursMs) {
            if (!perModel5h[model]) perModel5h[model] = { input: 0, output: 0, cost: 0, calls: 0 };
            perModel5h[model].input += norm.input;
            perModel5h[model].output += norm.output;
            perModel5h[model].cost += norm.cost;
            perModel5h[model].calls++;
          }
          if (now - ts < oneWeekMs) {
            if (!perModelWeek[model]) perModelWeek[model] = { input: 0, output: 0, cost: 0, calls: 0 };
            perModelWeek[model].input += norm.input;
            perModelWeek[model].output += norm.output;
            perModelWeek[model].cost += norm.cost;
            perModelWeek[model].calls++;
          }
          if (now - ts < fiveHoursMs) {
            recentMessages.push({ ts, model, input: norm.input, output: norm.output, cost: norm.cost });
          }
        } catch {}
      }
    }

    recentMessages.sort((a, b) => b.ts - a.ts);

    const estimatedLimits = { opus: 88000, sonnet: 220000 };

    let windowStart = null;
    if (recentMessages.length > 0) {
      windowStart = recentMessages[recentMessages.length - 1].ts;
    }
    const windowResetIn = windowStart ? Math.max(0, (windowStart + fiveHoursMs) - now) : 0;

    const thirtyMinAgo = now - 30 * 60000;
    const recent30 = recentMessages.filter(m => m.ts >= thirtyMinAgo);
    let burnTokensPerMin = 0;
    let burnCostPerMin = 0;
    if (recent30.length > 0) {
      const totalOut30 = recent30.reduce((s, m) => s + m.output, 0);
      const totalCost30 = recent30.reduce((s, m) => s + m.cost, 0);
      const spanMs = Math.max(now - Math.min(...recent30.map(m => m.ts)), 60000);
      burnTokensPerMin = totalOut30 / (spanMs / 60000);
      burnCostPerMin = totalCost30 / (spanMs / 60000);
    }

    const opusKey = Object.keys(perModel5h).find(k => k.includes('opus')) || '';
    const opusOut = opusKey ? perModel5h[opusKey].output : 0;
    const sonnetKey = Object.keys(perModel5h).find(k => k.includes('sonnet')) || '';
    const sonnetOut = sonnetKey ? perModel5h[sonnetKey].output : 0;

    const opusRemaining = estimatedLimits.opus - opusOut;
    const timeToLimit = burnTokensPerMin > 0 ? (opusRemaining / burnTokensPerMin) * 60000 : null;

    const perModelCost5h = {};
    for (const [model, data] of Object.entries(perModel5h)) {
      const pricing = getModelPricing(model);
      perModelCost5h[model] = {
        inputCost: pricing ? (data.input || 0) / 1e6 * pricing.input : 0,
        outputCost: pricing ? (data.output || 0) / 1e6 * pricing.output : 0,
        totalCost: data.cost || 0
      };
    }

    const totalCost5h = Object.values(perModel5h).reduce((s, m) => s + (m.cost || 0), 0);
    const totalCalls5h = Object.values(perModel5h).reduce((s, m) => s + (m.calls || 0), 0);
    const costLimit = 500.0; // equivalent API cost budget per 5h window (informational)
    const messageLimit = 1000;

    return {
      fiveHour: {
        perModel: perModel5h,
        perModelCost: perModelCost5h,
        windowStart,
        windowResetIn,
        recentCalls: recentMessages.slice(0, 20).map(m => ({
          ...m,
          ago: Math.round((now - m.ts) / 60000) + 'm ago'
        }))
      },
      weekly: {
        perModel: perModelWeek
      },
      burnRate: { tokensPerMinute: Math.round(burnTokensPerMin * 100) / 100, costPerMinute: Math.round(burnCostPerMin * 10000) / 10000 },
      estimatedLimits,
      current: {
        opusOutput: opusOut,
        sonnetOutput: sonnetOut,
        totalCost: Math.round(totalCost5h * 100) / 100,
        totalCalls: totalCalls5h,
        opusPct: Math.round((opusOut / estimatedLimits.opus) * 100),
        sonnetPct: Math.round((sonnetOut / estimatedLimits.sonnet) * 100),
        costPct: Math.round((totalCost5h / costLimit) * 100),
        messagePct: Math.round((totalCalls5h / messageLimit) * 100),
        costLimit,
        messageLimit
      },
      predictions: { timeToLimit: timeToLimit ? Math.round(timeToLimit) : null, safe: !timeToLimit || timeToLimit > 3600000 }
    };
  } catch (e) {
    return { fiveHour: { perModel: {} }, weekly: { perModel: {} } };
  }
}

// Track rate limit hits from OpenClaw logs
function getRateLimitEvents() {
  try {
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    const events = [];
    const now = Date.now();
    const fiveHoursMs = 5 * 3600000;

    for (const file of files) {
      const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
          if (now - ts > fiveHoursMs) continue;
          // Check for rate limit / overloaded errors
          if (d.type === 'error' || (d.message && d.message.stopReason === 'rate_limit')) {
            const text = JSON.stringify(d);
            if (text.includes('rate') || text.includes('overloaded') || text.includes('429') || text.includes('limit')) {
              events.push({ ts, type: 'rate_limit', detail: text.substring(0, 200) });
            }
          }
        } catch {}
      }
    }
    return events;
  } catch { return []; }
}

let usageCache = null;
let usageCacheTime = 0;

// System stats
function getSystemStats() {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    let cpuTemp = null;
    try {
      const tempRaw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
      cpuTemp = parseInt(tempRaw) / 1000;
    } catch {}

    const loadAvg = os.loadavg();
    const uptime = os.uptime();

    let cpuUsage = 0;
    try {
      const loadAvg1m = os.loadavg()[0];
      const numCpus = os.cpus().length;
      cpuUsage = Math.min(Math.round((loadAvg1m / numCpus) * 100), 100);
    } catch {
      cpuUsage = 0;
    }

    let diskPercent = 0, diskUsed = '', diskTotal = '';
    try {
      const { execSync } = require('child_process');
      const df = execSync("df / --output=pcent,used,size -B1G | tail -1", { encoding: 'utf8' }).trim();
      const parts = df.split(/\s+/);
      diskPercent = parseInt(parts[0]);
      diskUsed = parts[1] + 'G';
      diskTotal = parts[2] + 'G';
    } catch {}

    let crashCount = 0;
    try {
      const { execSync } = require('child_process');
      const logs = execSync("journalctl -u openclaw --since '7 days ago' --no-pager -o short 2>/dev/null | grep -ci 'SIGABRT\\|SIGSEGV\\|exit code [1-9]\\|process crashed\\|fatal error' || echo 0", { encoding: 'utf8' }).trim();
      crashCount = parseInt(logs) || 0;
    } catch {}

    let crashesToday = 0;
    try {
      const { execSync } = require('child_process');
      const logs = execSync("journalctl -u openclaw --since today --no-pager -o short 2>/dev/null | grep -ci 'SIGABRT\\|SIGSEGV\\|exit code [1-9]\\|process crashed\\|fatal error' || echo 0", { encoding: 'utf8' }).trim();
      crashesToday = parseInt(logs) || 0;
    } catch {}

    return {
      cpu: { usage: cpuUsage, temp: cpuTemp },
      disk: { percent: diskPercent, used: diskUsed, total: diskTotal },
      crashCount,
      crashesToday,
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        percent: memPercent,
        totalGB: (totalMem / 1073741824).toFixed(1),
        usedGB: (usedMem / 1073741824).toFixed(1),
        freeGB: (freeMem / 1073741824).toFixed(1)
      },
      loadAvg: { '1m': loadAvg[0].toFixed(2), '5m': loadAvg[1].toFixed(2), '15m': loadAvg[2].toFixed(2) },
      uptime: uptime
    };
  } catch (e) {
    return { cpu: { usage: 0, temp: null }, memory: { total: 0, used: 0, free: 0, percent: 0 }, loadAvg: { '1m': 0, '5m': 0, '15m': 0 }, uptime: 0 };
  }
}

let liveClients = [];
let liveWatcher = null;
let chatClients = [];

function broadcastChatEvent(msg) {
  if (chatClients.length === 0) return;
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  chatClients.forEach(res => { try { res.write(data); } catch {} });
}
const _fileWatchers = {};
const _fileSizes = {};

function watchSessionFileByPath(filePath, sessionKey) {
  const watchKey = filePath;
  if (_fileWatchers[watchKey]) return;
  try {
    _fileSizes[watchKey] = fs.statSync(filePath).size;
  } catch { _fileSizes[watchKey] = 0; }

  try {
    _fileWatchers[watchKey] = fs.watch(filePath, (eventType) => {
      if (eventType !== 'change') return;
      try {
        const stats = fs.statSync(filePath);
        if (stats.size <= (_fileSizes[watchKey] || 0)) return;
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.allocUnsafe(stats.size - (_fileSizes[watchKey] || 0));
        fs.readSync(fd, buffer, 0, buffer.length, _fileSizes[watchKey] || 0);
        fs.closeSync(fd);
        _fileSizes[watchKey] = stats.size;
        buffer.toString('utf8').split('\n').filter(l => l.trim()).forEach(line => {
          try { const data = JSON.parse(line); data._sessionKey = sessionKey; broadcastLiveEvent(data); } catch {}
        });
      } catch {}
    });
  } catch {}
}

function watchSessionFile(file) {
  watchSessionFileByPath(path.join(sessDir, file), file.replace('.jsonl', ''));
}

function startLiveWatcher() {
  if (liveWatcher) return;
  try {
    // Watch OpenClaw session files
    fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')).forEach(watchSessionFile);
    liveWatcher = fs.watch(sessDir, (eventType, filename) => {
      if (filename && filename.endsWith('.jsonl') && !_fileWatchers[path.join(sessDir, filename)]) {
        try { if (fs.existsSync(path.join(sessDir, filename))) watchSessionFile(filename); } catch {}
      }
    });
    // Watch Claude CLI session files (recently modified only)
    const cutoff = Date.now() - 3600000; // last 1 hour
    try {
      const dirs = fs.readdirSync(claudeCliDir).filter(d => {
        try { return !d.startsWith('-tmp-antfarm-work') && fs.statSync(path.join(claudeCliDir, d)).isDirectory(); } catch { return false; }
      });
      for (const dir of dirs) {
        const dirPath = path.join(claudeCliDir, dir);
        try {
          const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
          for (const f of files) {
            const fp = path.join(dirPath, f);
            try {
              if (fs.statSync(fp).mtimeMs > cutoff) {
                watchSessionFileByPath(fp, f.replace('.jsonl', ''));
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
  } catch {}
}

function broadcastLiveEvent(data) {
  if (liveClients.length === 0) return;
  
  const event = formatLiveEvent(data);
  if (!event) return;
  
  const message = `data: ${JSON.stringify(event)}\n\n`;
  liveClients.forEach(res => {
    try {
      res.write(message);
    } catch {}
  });
}

function formatLiveEvent(data) {
  const timestamp = data.timestamp || new Date().toISOString();
  const sessionKey = data._sessionKey || data.sessionId || 'unknown';
  
  const sessions = getSessionsJson();
  const session = sessions.find(s => s.sessionId === sessionKey || s.key.includes(sessionKey));
  const label = session ? session.label : sessionKey.substring(0, 8);
  
  // Handle both OpenClaw format (type:'message', data.message) and Claude CLI format (type:'assistant'/'user', data.message)
  if (data.type === 'message' || data.type === 'assistant' || data.type === 'user') {
    const msg = data.message || data;
    if (!msg) return null;
    
    const role = msg.role || 'unknown';
    let content = '';
    
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          content = block.text.substring(0, 150);
          break;
        } else if (block.type === 'toolCall' || block.type === 'tool_use') {
          content = `🔧 ${block.name || block.toolName || 'tool'}(${(JSON.stringify(block.arguments || block.input || {})).substring(0, 80)})`;
          break;
        } else if (block.type === 'toolResult' || block.type === 'tool_result') {
          const rc = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
          content = `📋 Result: ${rc.substring(0, 100)}`;
          break;
        } else if (block.type === 'thinking') {
          content = `💭 ${(block.thinking || '').substring(0, 100)}`;
          break;
        }
      }
      if (!content && msg.content[0]) {
        content = JSON.stringify(msg.content[0]).substring(0, 100);
      }
    } else if (typeof msg.content === 'string') {
      content = msg.content.substring(0, 150);
    }
    
    // For tool results at top level
    if (!content && msg.type === 'tool_result') {
      const rc = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      content = `📋 ${rc.substring(0, 100)}`;
    }
    
    if (!content) return null;
    
    return {
      timestamp,
      session: label,
      role,
      content: content.replace(/\n/g, ' ').trim()
    };
  }
  
  return null;
}

function getCronJobs() {
  try {
    if (!fs.existsSync(cronFile)) return [];
    const data = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
    return (data.jobs || []).map(j => {
      let humanSchedule = j.schedule?.expr || '';
      try {
        const parts = humanSchedule.split(' ');
        if (parts.length === 5) {
          const [min, hour, dom, mon, dow] = parts;
          const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
          let readable = '';
          if (dow !== '*') readable = dowNames[parseInt(dow)] || dow;
          if (hour !== '*' && min !== '*') readable += (readable ? ' ' : '') + `${hour.padStart(2,'0')}:${min.padStart(2,'0')}`;
          if (j.schedule?.tz) readable += ` (${j.schedule.tz.split('/').pop()})`;
          if (readable) humanSchedule = readable;
        }
      } catch {}
      return {
        id: j.id,
        name: j.name || j.id.substring(0, 8),
        schedule: humanSchedule,
        enabled: j.enabled !== false,
        lastStatus: j.state?.lastStatus || 'unknown',
        lastRunAt: j.state?.lastRunAtMs || 0,
        nextRunAt: j.state?.nextRunAtMs || 0,
        lastDuration: j.state?.lastDurationMs || 0
      };
    });
  } catch { return []; }
}

function getGitActivity() {
  try {
    const { execSync } = require('child_process');
    const repos = getGitRepos();
    const commits = [];
    for (const repo of repos) {
      try {
        if (!fs.existsSync(path.join(repo.path, '.git'))) continue;
        const log = execSync(`git -C ${repo.path} log --oneline --since='7 days ago' -10 --format='%H|%s|%at'`, { encoding: 'utf8', timeout: 5000 }).trim();
        if (!log) continue;
        log.split('\n').forEach(line => {
          const [hash, msg, ts] = line.split('|');
          commits.push({ repo: repo.name, hash: (hash || '').substring(0, 7), message: msg || '', timestamp: parseInt(ts || '0') * 1000 });
        });
      } catch {}
    }
    commits.sort((a, b) => b.timestamp - a.timestamp);
    return commits.slice(0, 15);
  } catch { return []; }
}

function getServicesStatus() {
  const { execSync } = require('child_process');
  const services = ['openclaw', 'agent-dashboard', 'tailscaled'];
  return services.map(name => {
    try {
      const status = execSync(`systemctl is-active ${name} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
      return { name, active: status === 'active' };
    } catch { return { name, active: false }; }
  });
}

function getMemoryFiles() {
  const files = [];
  try {
    if (fs.existsSync(memoryMdPath)) {
      const stat = fs.statSync(memoryMdPath);
      files.push({ name: 'MEMORY.md', modified: stat.mtimeMs, size: stat.size });
    }
  } catch {}
  try {
    if (fs.existsSync(heartbeatPath)) {
      const stat = fs.statSync(heartbeatPath);
      files.push({ name: 'HEARTBEAT.md', modified: stat.mtimeMs, size: stat.size });
    }
  } catch {}
  try {
    if (fs.existsSync(memoryDir)) {
      const entries = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).sort().reverse();
      entries.forEach(e => {
        try {
          const stat = fs.statSync(path.join(memoryDir, e));
          files.push({ name: 'memory/' + e, modified: stat.mtimeMs, size: stat.size });
        } catch {}
      });
    }
  } catch {}
  return files;
}

// --- Docs browser (P9 dashboard enhancement) ---
const DOCS_BASE = '/home/motobot';
const DOCS_CATEGORIES = [
  {
    id: 'identity', label: 'Identity & Principles',
    files: [
      { path: '.openclaw/workspace/SOUL.md', label: 'SOUL.md' },
      { path: '.openclaw/workspace/IDENTITY.md', label: 'IDENTITY.md' },
      { path: '.openclaw/workspace/AGENTS.md', label: 'AGENTS.md' },
      { path: 'claw-projects/principles.md', label: 'Principles' },
      { path: '.openclaw/workspace/USER.md', label: 'USER.md' },
      { path: '.openclaw/workspace/TOOLS.md', label: 'TOOLS.md' },
    ]
  },
  {
    id: 'projects', label: 'Projects & Tracking',
    files: [
      { path: 'claw-projects/IMPROVEMENT-PROJECTS.md', label: 'Projects' },
      { path: 'claw-projects/insights-summary.md', label: 'Insights Summary' },
      { path: '.openclaw/workspace/PLAN.md', label: 'Current Plan' },
    ]
  },
  {
    id: 'memory', label: 'Memory',
    files: [
      { path: '.openclaw/workspace/MEMORY.md', label: 'MEMORY.md' },
      { path: '.openclaw/workspace/HEARTBEAT.md', label: 'HEARTBEAT.md' },
    ]
  },
  {
    id: 'decisions', label: 'Decisions',
    dir: 'claw-projects/decisions', ext: '.md'
  },
  {
    id: 'research', label: 'Research',
    dir: 'claw-projects/research', ext: '.md'
  },
  {
    id: 'specs-claw', label: 'Specs (Antfarm/Worker)',
    dir: 'claw-projects/specs', ext: '.md', recursive: true
  },
  {
    id: 'specs-openclaw-support', label: 'Specs (OpenClaw Stabilization)',
    dir: 'ai-Projects/debugging-con-claude/specs/openclaw-support', ext: '.md'
  },
  {
    id: 'specs-workspace', label: 'Specs (Workspace)',
    dir: '.openclaw/workspace/specs', ext: '.md', recursive: true
  },
  {
    id: 'specs-motobots', label: 'Specs (Motobots)',
    dir: 'ai-Projects/motobots/specs', ext: '.md', recursive: true
  },
  {
    id: 'specs-innova-mota', label: 'Innova Mota (P80)',
    files: [
      { path: '.openclaw/workspace/specs/p80-fermentia-generalize/research.md', label: 'P80 Research' },
      { path: '.openclaw/workspace/specs/p80-fermentia-generalize/requirements.md', label: 'P80 Requirements' },
      { path: '.openclaw/workspace/specs/p80-fermentia-generalize/design.md', label: 'P80 Design' },
      { path: '.openclaw/workspace/specs/p80-fermentia-generalize/tasks.md', label: 'P80 Tasks' },
      { path: '.openclaw/workspace/specs/p80-fermentia-generalize/.progress.md', label: 'P80 Progress' },
      { path: '.openclaw/workspace/specs/geo-research-innova-mota.md', label: 'GEO Research (P85)' },
      { path: 'claw-projects/research/p83-naming-research.md', label: 'Naming Research (P83)' },
    ]
  },
  {
    id: 'specs-fermentia-legacy', label: 'Specs (Fermentia v3-v5)',
    dir: 'ai-Projects/sitio-web-lu-4/specs', ext: '.md', recursive: true
  },
  {
    id: 'specs-genexus', label: 'Specs (CMS Genexus P70)',
    dir: 'Downloads/CMSGeneXus/specs/new-genexus-com', ext: '.md'
  },
  {
    id: 'specs-ralph', label: 'Specs (Ralph Dev)',
    dir: 'ai-Projects/smart-ralph-main/specs', ext: '.md', recursive: true
  },
  {
    id: 'viaje', label: 'Viaje Escocia & Inglaterra 2026',
    dir: 'claw-projects/viaje-escocia-2026', ext: '.md'
  },
];

function getDocsIndex() {
  const categories = [];
  for (const cat of DOCS_CATEGORIES) {
    const items = [];
    if (cat.files) {
      for (const f of cat.files) {
        const full = path.join(DOCS_BASE, f.path);
        try {
          if (fs.existsSync(full)) {
            const stat = fs.statSync(full);
            items.push({ name: f.label, path: f.path, modified: stat.mtimeMs, size: stat.size });
          }
        } catch {}
      }
    }
    if (cat.dir) {
      const dirFull = path.join(DOCS_BASE, cat.dir);
      try {
        if (fs.existsSync(dirFull)) {
          if (cat.recursive) {
            // Recursive: walk subdirectories, prefix file names with subfolder
            const topEntries = fs.readdirSync(dirFull).sort();
            for (const entry of topEntries) {
              const entryPath = path.join(dirFull, entry);
              const entryStat = fs.statSync(entryPath);
              if (entryStat.isFile() && entry.endsWith(cat.ext || '.md') && !entry.startsWith('.')) {
                items.push({ name: entry, path: cat.dir + '/' + entry, modified: entryStat.mtimeMs, size: entryStat.size });
              } else if (entryStat.isDirectory() && !entry.startsWith('.')) {
                const subEntries = fs.readdirSync(entryPath).filter(e => e.endsWith(cat.ext || '.md') && !e.startsWith('.')).sort();
                for (const sub of subEntries) {
                  try {
                    const subStat = fs.statSync(path.join(entryPath, sub));
                    items.push({ name: entry + '/' + sub, path: cat.dir + '/' + entry + '/' + sub, modified: subStat.mtimeMs, size: subStat.size });
                  } catch {}
                }
              }
            }
          } else {
            const entries = fs.readdirSync(dirFull).filter(e => e.endsWith(cat.ext || '.md') && !e.startsWith('.')).sort();
            for (const e of entries) {
              try {
                const stat = fs.statSync(path.join(dirFull, e));
                items.push({ name: e, path: cat.dir + '/' + e, modified: stat.mtimeMs, size: stat.size });
              } catch {}
            }
          }
        }
      } catch {}
    }
    // Sort dir-based categories by modification time (newest first)
    if (cat.dir) items.sort((a, b) => b.modified - a.modified);
    if (items.length > 0) categories.push({ id: cat.id, label: cat.label, files: items });
  }
  return categories;
}

// Allowlist of readable directories for docs endpoint (security)
const DOCS_ALLOWED_DIRS = [
  'claw-projects/', '.openclaw/workspace/', 'ai-Projects/', 'Downloads/CMSGeneXus/'
];

function isDocPathAllowed(relPath) {
  if (relPath.includes('..')) return false;
  return DOCS_ALLOWED_DIRS.some(d => relPath.startsWith(d));
}

function getTodayTokens() {
  try {
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    const now = new Date();
    const todayStr = now.toISOString().substring(0, 10);
    const perModel = {};
    let totalInput = 0, totalOutput = 0;

    for (const file of files) {
      const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'message') continue;
          const ts = d.timestamp || '';
          if (!ts.startsWith(todayStr)) continue;
          const msg = d.message;
          if (!msg || !msg.usage) continue;
          const model = (msg.model || 'unknown').split('/').pop();
          if (model === 'delivery-mirror') continue;
          const inTok = (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0);
          const outTok = msg.usage.output || 0;
          if (!perModel[model]) perModel[model] = { input: 0, output: 0 };
          perModel[model].input += inTok;
          perModel[model].output += outTok;
          totalInput += inTok;
          totalOutput += outTok;
        } catch {}
      }
    }
    return { totalInput, totalOutput, perModel };
  } catch { return { totalInput: 0, totalOutput: 0, perModel: {} }; }
}

function getAvgResponseTime() {
  try {
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    const now = new Date();
    const todayStr = now.toISOString().substring(0, 10);
    const diffs = [];

    for (const file of files) {
      const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
      let lastUserTs = null;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'message') continue;
          const ts = d.timestamp || '';
          if (!ts.startsWith(todayStr)) continue;
          const role = d.message?.role;
          const msgTs = new Date(ts).getTime();
          if (role === 'user') {
            lastUserTs = msgTs;
          } else if (role === 'assistant' && lastUserTs) {
            const diff = msgTs - lastUserTs;
            if (diff > 0 && diff < 600000) diffs.push(diff);
            lastUserTs = null;
          }
        } catch {}
      }
    }
    if (diffs.length === 0) return 0;
    return Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length / 1000);
  } catch { return 0; }
}

function trackDiskHistory(diskPercent) {
  const histFile = path.join(__dirname, 'disk-history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch {}
  const now = Date.now();
  if (history.length > 0 && now - history[history.length - 1].t < 1800000) return history;
  history.push({ t: now, v: diskPercent });
  if (history.length > 48) history = history.slice(-48);
  try { fs.writeFileSync(histFile, JSON.stringify(history)); } catch {}
  return history;
}

// Health history tracking
let healthHistory = [];
try {
  if (fs.existsSync(healthHistoryFile)) {
    healthHistory = JSON.parse(fs.readFileSync(healthHistoryFile, 'utf8'));
  }
} catch {}

function saveHealthSnapshot() {
  try {
    const stats = getSystemStats();
    const now = Date.now();
    healthHistory.push({
      t: now,
      cpu: stats.cpu?.usage || 0,
      ram: stats.memory?.percent || 0
    });
    // Keep last 24h (288 points at 5min intervals)
    if (healthHistory.length > 288) {
      healthHistory = healthHistory.slice(-288);
    }
    const dir = path.dirname(healthHistoryFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(healthHistoryFile, JSON.stringify(healthHistory));
  } catch (e) {
    console.error('Health snapshot error:', e);
  }
}

// Save health snapshot every 5 minutes
setInterval(saveHealthSnapshot, 5 * 60 * 1000);
saveHealthSnapshot(); // Initial snapshot

const server = http.createServer((req, res) => {
  // Security headers for all responses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Auth endpoints (always accessible)
  if (req.url === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        if (password === AUTH_PASSWORD) {
          const token = generateSessionToken();
          authSessions.set(token, { created: Date.now() });
          const isSecure = req.headers['x-forwarded-proto'] === 'https' || (req.headers.host || '').includes('.ts.net');
          const cookieFlags = `dash_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}${isSecure ? '; Secure' : ''}`;
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': cookieFlags
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        }
      } catch { res.writeHead(400); res.end('Bad request'); }
    });
    return;
  }
  if (req.url === '/api/auth/logout') {
    const isSecure = req.headers['x-forwarded-proto'] === 'https' || (req.headers.host || '').includes('.ts.net');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `dash_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure ? '; Secure' : ''}`
    });
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.dash_session) authSessions.delete(cookies.dash_session);
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Bot API uses its own token auth — skip session check
  if (req.url === '/api/chat/bot' && req.method === 'POST') {
    // handled below in chat section
  } else if (!isAuthenticated(req)) {
    // API calls get JSON 401; browser gets login page
    if (req.url.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' });
    res.end(loginPage);
    return;
  }

  if (req.url === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getSessionsJson()));
    return;
  }
  if (req.url === '/api/usage') {
    const now = Date.now();
    if (!usageCache || now - usageCacheTime > 10000) {
      usageCache = getUsageWindows();
      usageCacheTime = now;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(usageCache));
    return;
  }
  if (req.url === '/api/costs') {
    const now = Date.now();
    if (!costCache || now - costCacheTime > 60000) {
      costCache = getCostData();
      costCacheTime = now;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(costCache));
    return;
  }
  if (req.url === '/api/system') {
    const stats = getSystemStats();
    if (stats.disk) stats.diskHistory = trackDiskHistory(stats.disk.percent || 0);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(stats));
    return;
  }
  if (req.url.startsWith('/api/session-messages?')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const rawId = params.get('id') || '';
    const sessionId = rawId.replace(/[^a-zA-Z0-9\-_:.]/g, '');
    const messages = [];
    try {
      const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      let targetFile = files.find(f => f.includes(sessionId));
      if (!targetFile) {
        const sFile = path.join(sessDir, 'sessions.json');
        const data = JSON.parse(fs.readFileSync(sFile, 'utf8'));
        for (const [k, v] of Object.entries(data)) {
          if (k === sessionId && v.sessionId) {
            targetFile = files.find(f => f.includes(v.sessionId));
            break;
          }
        }
      }
      if (targetFile) {
        const lines = fs.readFileSync(path.join(sessDir, targetFile), 'utf8').split('\n').filter(l => l.trim());
        for (let i = Math.max(0, lines.length - 30); i < lines.length; i++) {
          try {
            const d = JSON.parse(lines[i]);
            if (d.type !== 'message') continue;
            const msg = d.message;
            if (!msg) continue;
            let text = '';
            if (typeof msg.content === 'string') text = msg.content;
            else if (Array.isArray(msg.content)) {
              for (const b of msg.content) {
                if (b.type === 'text' && b.text) { text = b.text; break; }
                if (b.type === 'tool_use' || b.type === 'toolCall') { text = '🔧 ' + (b.name || b.toolName || 'tool'); break; }
              }
            }
            if (text) messages.push({ role: msg.role || 'unknown', content: text.substring(0, 300), timestamp: d.timestamp || '' });
          } catch {}
        }
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(messages));
    return;
  }
  // Thread messages endpoint — full conversation history for condensador
  if (req.url.startsWith('/api/thread-messages?')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const rawId = params.get('session_id') || params.get('id') || '';
    const sessionId = rawId.replace(/[^a-zA-Z0-9\-_:.]/g, '');
    const limit = Math.min(parseInt(params.get('limit') || '100', 10), 500);
    const beforeTs = params.get('before') || null;
    const messages = [];
    let hasMore = false;
    try {
      const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      let targetFile = files.find(f => f.includes(sessionId));
      if (!targetFile) {
        const sFile = path.join(sessDir, 'sessions.json');
        const data = JSON.parse(fs.readFileSync(sFile, 'utf8'));
        for (const [k, v] of Object.entries(data)) {
          if (k === sessionId && v.sessionId) {
            targetFile = files.find(f => f.includes(v.sessionId));
            break;
          }
        }
      }
      if (targetFile) {
        const lines = fs.readFileSync(path.join(sessDir, targetFile), 'utf8').split('\n').filter(l => l.trim());
        const allMsgs = [];
        for (const line of lines) {
          try {
            const d = JSON.parse(line);
            if (d.type !== 'message') continue;
            const msg = d.message;
            if (!msg || !msg.role) continue;
            if (msg.role === 'toolResult') continue;
            // Extract all text content
            let text = '';
            let toolNames = [];
            if (typeof msg.content === 'string') {
              text = msg.content;
            } else if (Array.isArray(msg.content)) {
              const textParts = msg.content.filter(c => c.type === 'text' && c.text).map(c => c.text);
              text = textParts.join('\n');
              toolNames = msg.content.filter(c => c.type === 'tool_use' || c.type === 'toolCall').map(c => c.name || c.toolName || 'tool');
            }
            // Skip empty assistant messages (tool-only turns)
            if (!text && msg.role === 'assistant' && toolNames.length > 0) {
              text = '[Tools: ' + toolNames.join(', ') + ']';
            }
            if (!text) continue;
            // Strip system prefixes from user messages for cleaner display
            let cleanText = text;
            if (msg.role === 'user') {
              cleanText = text.replace(/^\[(?:Telegram|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\]]*\]\s*/s, '');
              cleanText = cleanText.replace(/^\[message_id:[^\]]*\]\s*/g, '');
              cleanText = cleanText.replace(/^Conversation info \(untrusted.*?\n```json\n[\s\S]*?```\n*/m, '');
              cleanText = cleanText.replace(/^System:.*$/m, '').trim();
            }
            if (!cleanText) continue;
            const ts = d.timestamp || '';
            if (beforeTs && ts >= beforeTs) continue;
            allMsgs.push({
              id: d.id || '',
              role: msg.role,
              content: cleanText.substring(0, 5000),
              model: msg.model || null,
              timestamp: ts,
              tools: toolNames.length > 0 ? toolNames : undefined,
            });
          } catch {}
        }
        // Return last N messages (most recent)
        if (allMsgs.length > limit) {
          hasMore = true;
        }
        const slice = allMsgs.slice(-limit);
        messages.push(...slice);
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ messages, hasMore, oldestTimestamp: messages.length > 0 ? messages[0].timestamp : null }));
    return;
  }
  if (req.url === '/api/crons') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getCronJobs()));
    return;
  }
  if (req.url === '/api/git') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getGitActivity()));
    return;
  }
  if (req.url === '/api/services') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getServicesStatus()));
    return;
  }
  if (req.url === '/api/memory') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getMemoryFiles()));
    return;
  }
  if (req.url === '/api/tokens-today') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getTodayTokens()));
    return;
  }
  if (req.url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ name: 'OpenClaw Dashboard', version: '1.0.0' }));
    return;
  }
  if (req.url === '/api/claude-usage-scrape' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    const { exec } = require('child_process');
    if (fs.existsSync(scrapeScript)) {
      exec(`bash ${scrapeScript}`, { timeout: 60000 }, (err) => {});
      res.end(JSON.stringify({ status: 'started' }));
    } else {
      res.end(JSON.stringify({ status: 'error', message: 'Scrape script not found' }));
    }
    return;
  }
  if (req.url === '/api/claude-usage') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const data = JSON.parse(fs.readFileSync(claudeUsageFile, 'utf8'));
      res.end(JSON.stringify(data));
    } catch {
      res.end(JSON.stringify({ error: 'No usage data. Run scrape-claude-usage.sh first.' }));
    }
    return;
  }
  // ===== OUTPUT PANEL API =====
  if (req.url === '/api/output') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(antfarmDbPath, { open: true, readOnly: true });

      // 1. Completed runs (last 30)
      const runs = db.prepare(`
        SELECT r.id, r.workflow_id, r.task, r.status, r.created_at, r.updated_at
        FROM runs r WHERE r.status = 'completed'
        ORDER BY r.updated_at DESC LIMIT 30
      `).all();

      // 2. Get last step output for each run
      const runDetails = runs.map(r => {
        const lastStep = db.prepare(`
          SELECT step_id, status, output FROM steps
          WHERE run_id = ? ORDER BY step_index DESC LIMIT 1
        `).get(r.id);
        const pidMatch = r.task.match(/P\d+/);
        return {
          id: r.id.substring(0, 8),
          fullId: r.id,
          workflow: r.workflow_id,
          project: pidMatch ? pidMatch[0] : null,
          title: r.task.split('\n')[0].substring(0, 120),
          created: r.created_at,
          updated: r.updated_at,
          lastStep: lastStep ? lastStep.step_id : null,
          output: lastStep && lastStep.output ? lastStep.output.substring(0, 500) : null
        };
      });

      // 3. PRs extracted from step outputs
      const prSteps = db.prepare(`
        SELECT s.run_id, s.output, s.updated_at FROM steps s
        WHERE s.output LIKE '%PR: https://%' OR s.output LIKE '%PR:%https://%'
        ORDER BY s.updated_at DESC LIMIT 20
      `).all();
      const seenUrls = new Set();
      const prs = prSteps.map(s => {
        const match = s.output.match(/PR:\s*(https:\/\/[^\s]+)/);
        if (!match || seenUrls.has(match[1])) return null;
        seenUrls.add(match[1]);
        const run = runs.find(r => r.id === s.run_id);
        const pidMatch = run ? run.task.match(/P\d+/) : null;
        return { url: match[1], project: pidMatch ? pidMatch[0] : null, date: s.updated_at };
      }).filter(Boolean);

      db.close();

      // 4. Research files from claw-projects/research/
      const researchDir = path.join('/home/motobot/claw-projects/research');
      let research = [];
      try {
        research = fs.readdirSync(researchDir)
          .filter(f => f.endsWith('.md') && !f.startsWith('.'))
          .map(f => {
            const stat = fs.statSync(path.join(researchDir, f));
            return { name: f, modified: stat.mtimeMs, size: stat.size, path: 'claw-projects/research/' + f };
          })
          .sort((a, b) => b.modified - a.modified);
      } catch {}

      // 5. Stats
      const now = new Date();
      const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
      const runsThisWeek = runDetails.filter(r => r.updated >= weekAgo).length;
      const researchThisWeek = research.filter(r => r.modified > now - 7 * 24 * 60 * 60 * 1000).length;

      res.end(JSON.stringify({
        runs: runDetails,
        prs,
        research,
        stats: {
          runsTotal: runDetails.length,
          runsThisWeek,
          prsTotal: prs.length,
          researchTotal: research.length,
          researchThisWeek
        }
      }));
    } catch (e) {
      res.end(JSON.stringify({ error: e.message, runs: [], prs: [], research: [], stats: {} }));
    }
    return;
  }
  // ===== ANTFARM API =====
  if (req.url === '/api/antfarm') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(antfarmDbPath, { open: true, readOnly: true });
      const runs = db.prepare('SELECT id, workflow_id, task, status, context, created_at, updated_at FROM runs ORDER BY created_at DESC LIMIT 20').all();
      const queue = db.prepare("SELECT id, workflow_id, task, status FROM runs WHERE status IN ('queued','running') ORDER BY created_at DESC").all();
      const counts = db.prepare('SELECT status, COUNT(*) as cnt FROM runs GROUP BY status').all();
      // Get steps for recent runs (last 5)
      const recentRunIds = runs.slice(0, 5).map(r => r.id);
      const stepsMap = {};
      for (const rid of recentRunIds) {
        stepsMap[rid] = db.prepare('SELECT step_id, step_index, status, output, type, created_at, updated_at FROM steps WHERE run_id = ? ORDER BY step_index ASC').all(rid);
      }
      db.close();
      res.end(JSON.stringify({ runs, queue, counts: Object.fromEntries(counts.map(c => [c.status, c.cnt])), steps: stepsMap }));
    } catch (e) {
      res.end(JSON.stringify({ error: e.message, runs: [], queue: [], counts: {}, steps: {} }));
    }
    return;
  }
  if (req.url === '/api/response-time') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ avgSeconds: getAvgResponseTime() }));
    return;
  }
  if (req.url.startsWith('/api/logs?')) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const allowedServices = ['openclaw-gateway', 'openclaw-dashboard', 'tailscaled'];
      const service = params.get('service') || 'openclaw-gateway';
      if (!allowedServices.includes(service)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid service name');
        return;
      }
      const lines = Math.min(Math.max(parseInt(params.get('lines')) || 100, 1), 1000);
      const { execSync } = require('child_process');
      const logs = execSync(`journalctl --user -u ${service} --no-pager -n ${lines} -o short 2>/dev/null || echo "No logs available"`, { encoding: 'utf8', timeout: 10000 });
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end(logs);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error fetching logs');
    }
    return;
  }
  if (req.url === '/api/action/restart-openclaw' && req.method === 'POST') {
    try {
      const { exec } = require('child_process');
      exec('systemctl restart openclaw', (err) => {});
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/api/action/restart-dashboard' && req.method === 'POST') {
    try {
      const { exec } = require('child_process');
      setTimeout(() => {
        exec('systemctl restart agent-dashboard', (err) => {});
      }, 2000);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, message: 'Restarting in 2 seconds...' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/api/action/clear-cache' && req.method === 'POST') {
    try {
      costCache = null;
      usageCache = null;
      costCacheTime = 0;
      usageCacheTime = 0;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/api/action/restart-tailscale' && req.method === 'POST') {
    exec('systemctl restart tailscaled', (err) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: !err, error: err?.message }));
    });
    return;
  }
  if (req.url === '/api/action/update-openclaw' && req.method === 'POST') {
    exec('npm update -g openclaw', { timeout: 120000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: !err, output: stdout?.trim(), error: err?.message }));
    });
    return;
  }
  if (req.url === '/api/action/kill-tmux' && req.method === 'POST') {
    exec('tmux kill-server 2>/dev/null; echo ok', (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }
  if (req.url === '/api/action/gc' && req.method === 'POST') {
    const projDir = path.join(WORKSPACE_DIR, 'projects');
    exec(`if [ -d "${projDir}" ]; then for d in ${projDir}/*/; do cd "$d" && git gc --quiet 2>/dev/null; done; fi; cd ${WORKSPACE_DIR} && git gc --quiet 2>/dev/null; echo ok`, (err) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }
  if (req.url === '/api/action/check-update' && req.method === 'POST') {
    exec('npm outdated -g openclaw 2>/dev/null || echo "up to date"', { timeout: 30000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, output: (stdout || '').trim() || 'All packages up to date' }));
    });
    return;
  }
  if (req.url === '/api/action/sys-update' && req.method === 'POST') {
    exec('apt update -qq && apt upgrade -y -qq 2>&1 | tail -5', { timeout: 300000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: !err, output: (stdout || '').trim(), error: err?.message }));
    });
    return;
  }
  if (req.url === '/api/action/disk-cleanup' && req.method === 'POST') {
    exec('apt autoremove -y -qq 2>/dev/null; apt clean 2>/dev/null; journalctl --vacuum-time=7d 2>/dev/null; echo "Cleanup done"', { timeout: 60000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, output: (stdout || '').trim() }));
    });
    return;
  }
  if (req.url === '/api/action/restart-claude' && req.method === 'POST') {
    exec(`tmux kill-session -t claude-persistent 2>/dev/null; sleep 1; tmux new-session -d -s claude-persistent -x 200 -y 60 && tmux send-keys -t claude-persistent "cd ${WORKSPACE_DIR} && claude" Enter && echo "Claude session started"`, { timeout: 20000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: !err, output: (stdout || '').trim() }));
    });
    return;
  }
  if (req.url === '/api/tailscale') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const { execSync } = require('child_process');
      const statusJson = execSync('tailscale status --json 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      const status = JSON.parse(statusJson);
      const self = status.Self || {};
      const peers = Object.values(status.Peer || {}).filter(p => p.Online).length;
      let routes = [];
      try {
        const serveStatus = execSync('tailscale serve status 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
        if (serveStatus && !serveStatus.includes('No serve config')) {
          routes = serveStatus.split('\n').filter(l => l.includes('http')).map(l => l.trim());
        }
      } catch {}
      res.end(JSON.stringify({
        hostname: self.HostName || 'unknown',
        ip: self.TailscaleIPs?.[0] || 'unknown',
        online: self.Online || false,
        peers,
        routes
      }));
    } catch (e) {
      res.end(JSON.stringify({ error: 'Tailscale not available', hostname: '--', ip: '--', online: false, peers: 0, routes: [] }));
    }
    return;
  }
  if (req.url === '/api/lifetime-stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const now = Date.now();
      const cacheKey = 'lifetimeStats';
      const cacheTime = global[cacheKey + 'Time'] || 0;
      if (global[cacheKey] && now - cacheTime < 300000) {
        res.end(JSON.stringify(global[cacheKey]));
        return;
      }
      const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      let totalTokens = 0, totalMessages = 0, totalCost = 0, totalSessions = files.length;
      let firstSessionDate = null;
      const activeDays = new Set();
      for (const file of files) {
        const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type !== 'message') continue;
            totalMessages++;
            const msg = d.message;
            if (msg?.usage) {
              const inTok = (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0);
              const outTok = msg.usage.output || 0;
              totalTokens += inTok + outTok;
              totalCost += msg.usage.cost?.total || 0;
            }
            if (d.timestamp) {
              const ts = new Date(d.timestamp).getTime();
              if (!firstSessionDate || ts < firstSessionDate) firstSessionDate = ts;
              const day = d.timestamp.substring(0, 10);
              activeDays.add(day);
            }
          } catch {}
        }
      }
      const result = {
        totalTokens,
        totalMessages,
        totalCost: Math.round(totalCost * 100) / 100,
        totalSessions,
        firstSessionDate,
        daysActive: activeDays.size
      };
      global[cacheKey] = result;
      global[cacheKey + 'Time'] = now;
      res.end(JSON.stringify(result));
    } catch (e) {
      res.end(JSON.stringify({ totalTokens: 0, totalMessages: 0, totalCost: 0, totalSessions: 0, firstSessionDate: null, daysActive: 0 }));
    }
    return;
  }
  if (req.url === '/api/health-history') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(healthHistory));
    return;
  }
  // --- Docs browser endpoints ---
  if (req.url === '/api/docs') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getDocsIndex()));
    return;
  }
  if (req.url.startsWith('/api/doc?')) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const relPath = params.get('path') || '';
      if (!isDocPathAllowed(relPath)) throw new Error('Path not allowed');
      const fpath = path.join(DOCS_BASE, relPath);
      if (fs.existsSync(fpath)) {
        const content = fs.readFileSync(fpath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end(content);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
      }
    } catch (e) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
    }
    return;
  }

  if (req.url === '/api/memory-files') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getMemoryFiles()));
    return;
  }
  if (req.url.startsWith('/api/memory-file?')) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const fname = params.get('path') || '';
      let fpath = '';
      if (fname === 'MEMORY.md') fpath = memoryMdPath;
      else if (fname === 'HEARTBEAT.md') fpath = heartbeatPath;
      else if (fname.startsWith('memory/') && !fname.includes('..')) fpath = path.join(WORKSPACE_DIR, fname);
      else throw new Error('Invalid path');
      
      if (fs.existsSync(fpath)) {
        const content = fs.readFileSync(fpath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(content);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
    }
    return;
  }
  if (req.url.startsWith('/api/cron/') && req.method === 'POST') {
    try {
      const parts = req.url.split('/');
      const action = parts[parts.length - 1];
      const id = parts[parts.length - 2].replace(/[^a-zA-Z0-9\-_]/g, '');
      if (!id) { res.writeHead(400); res.end('Invalid id'); return; }
      
      if (action === 'toggle') {
        const { execSync } = require('child_process');
        if (!fs.existsSync(cronFile)) throw new Error('No cron file');
        const data = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
        const job = (data.jobs || []).find(j => j.id === id);
        if (!job) throw new Error('Job not found');
        job.enabled = !job.enabled;
        fs.writeFileSync(cronFile, JSON.stringify(data, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, enabled: job.enabled }));
      } else if (action === 'run') {
        const { exec } = require('child_process');
        exec(`openclaw cron run ${id}`, { timeout: 60000 }, (err) => {});
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/api/live') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    
    liveClients.push(res);
    startLiveWatcher();
    
    res.write('data: {"status":"connected"}\n\n');
    
    try {
      // Backfill from recently modified sessions (last 1h) — both sources
      const cutoff = Date.now() - 3600000;
      const backfillFiles = [];
      try {
        fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')).forEach(f => {
          const fp = path.join(sessDir, f);
          try { if (fs.statSync(fp).mtimeMs > cutoff) backfillFiles.push({ fp, sid: f.replace('.jsonl', '') }); } catch {}
        });
      } catch {}
      try {
        const dirs = fs.readdirSync(claudeCliDir).filter(d => {
          try { return !d.startsWith('-tmp-antfarm-work') && fs.statSync(path.join(claudeCliDir, d)).isDirectory(); } catch { return false; }
        });
        for (const dir of dirs) {
          try {
            fs.readdirSync(path.join(claudeCliDir, dir)).filter(f => f.endsWith('.jsonl')).forEach(f => {
              const fp = path.join(claudeCliDir, dir, f);
              try { if (fs.statSync(fp).mtimeMs > cutoff) backfillFiles.push({ fp, sid: f.replace('.jsonl', '') }); } catch {}
            });
          } catch {}
        }
      } catch {}
      const recentEvents = [];
      backfillFiles.forEach(({ fp, sid }) => {
        try {
          const content = fs.readFileSync(fp, 'utf8');
          const lines = content.split('\n').filter(l => l.trim());
          lines.slice(-5).forEach(line => {
            try {
              const data = JSON.parse(line);
              data._sessionKey = sid;
              const event = formatLiveEvent(data);
              if (event) recentEvents.push(event);
            } catch {}
          });
        } catch {}
      });
      recentEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      recentEvents.slice(0, 20).forEach(event => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
    } catch {}
    
    req.on('close', () => {
      liveClients = liveClients.filter(client => client !== res);
      if (liveClients.length === 0) {
        if (liveWatcher) { try { liveWatcher.close(); } catch {} liveWatcher = null; }
        Object.keys(_fileWatchers).forEach(k => { try { _fileWatchers[k].close(); } catch {} delete _fileWatchers[k]; });
      }
    });
    
    return;
  }
  // ===== CHAT LOGS (outgoing message history) =====
  if (req.url === '/api/chat-logs') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const files = fs.existsSync(chatLogsDir)
        ? fs.readdirSync(chatLogsDir).filter(f => f.endsWith('.log')).sort().reverse()
        : [];
      const index = files.map(f => {
        const stat = fs.statSync(path.join(chatLogsDir, f));
        // Parse date and channel from filename: YYYY-MM-DD-channel.log
        const match = f.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.log$/);
        return {
          file: f,
          date: match ? match[1] : f,
          channel: match ? match[2] : 'unknown',
          size: stat.size,
          modified: stat.mtimeMs
        };
      });
      res.end(JSON.stringify(index));
    } catch (e) {
      res.end('[]');
    }
    return;
  }
  if (req.url.startsWith('/api/chat-log?')) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const file = params.get('file') || '';
      // Security: only allow .log files, no path traversal
      if (!file.match(/^\d{4}-\d{2}-\d{2}-.+\.log$/) || file.includes('..') || file.includes('/')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid file name');
        return;
      }
      const fpath = path.join(chatLogsDir, file);
      if (fs.existsSync(fpath)) {
        const content = fs.readFileSync(fpath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(content);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
    }
    return;
  }
  // ===== CHAT SYSTEM =====
  if (req.url === '/api/chat/messages') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const msgs = fs.existsSync(chatFile) ? JSON.parse(fs.readFileSync(chatFile, 'utf8')) : [];
      res.end(JSON.stringify(msgs.slice(-100)));
    } catch { res.end('[]'); }
    return;
  }
  if (req.url === '/api/chat/send' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { text, role } = JSON.parse(body);
        if (!text || !text.trim()) throw new Error('Empty message');
        const msg = { id: Date.now().toString(36), role: role || 'user', text: text.trim(), ts: new Date().toISOString() };
        let msgs = [];
        try { msgs = JSON.parse(fs.readFileSync(chatFile, 'utf8')); } catch {}
        msgs.push(msg);
        if (msgs.length > 500) msgs = msgs.slice(-500);
        fs.writeFileSync(chatFile, JSON.stringify(msgs, null, 2));
        broadcastChatEvent(msg);
        if (msg.role === 'user') {
          fs.writeFileSync(chatCommandFile, msg.text + '\n');
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, msg }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.url === '/api/chat/bot' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { text, token } = JSON.parse(body);
        if (token !== CHAT_TOKEN) { res.writeHead(401); res.end('Unauthorized'); return; }
        if (!text || !text.trim()) throw new Error('Empty message');
        const msg = { id: Date.now().toString(36), role: 'bot', text: text.trim(), ts: new Date().toISOString() };
        let msgs = [];
        try { msgs = JSON.parse(fs.readFileSync(chatFile, 'utf8')); } catch {}
        msgs.push(msg);
        if (msgs.length > 500) msgs = msgs.slice(-500);
        fs.writeFileSync(chatFile, JSON.stringify(msgs, null, 2));
        broadcastChatEvent(msg);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.url === '/api/chat/live') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    chatClients.push(res);
    res.write('data: {"status":"connected"}\n\n');
    req.on('close', () => { chatClients = chatClients.filter(c => c !== res); });
    return;
  }
  if (req.url === '/api/chat/command') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    try {
      if (fs.existsSync(chatCommandFile)) {
        const cmd = fs.readFileSync(chatCommandFile, 'utf8').trim();
        fs.unlinkSync(chatCommandFile);
        res.end(cmd);
      } else {
        res.end('');
      }
    } catch { res.end(''); }
    return;
  }
  // ===== END CHAT SYSTEM =====

  // ===== CONTROL API =====
  if (req.url === '/api/control') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      // 1. Antfarm runs (recent 30)
      let antfarmRuns = [], antfarmSteps = {};
      try {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(antfarmDbPath, { open: true, readOnly: true });
        antfarmRuns = db.prepare('SELECT id, workflow_id, task, status, context, created_at, updated_at FROM runs ORDER BY updated_at DESC LIMIT 30').all();
        const activeIds = antfarmRuns.filter(r => ['running', 'queued', 'failed'].includes(r.status)).map(r => r.id);
        const recentIds = antfarmRuns.slice(0, 10).map(r => r.id);
        const idsToFetch = [...new Set([...activeIds, ...recentIds])];
        for (const rid of idsToFetch) {
          antfarmSteps[rid] = db.prepare('SELECT step_id, step_index, status, output, type, created_at, updated_at FROM steps WHERE run_id = ? ORDER BY step_index ASC').all(rid);
        }
        db.close();
      } catch (e) { /* antfarm unavailable */ }

      // 2. Spec proposals (recent, non-expired)
      const proposalsPath = path.join(os.homedir(), 'claw-projects', 'spec-proposals.json');
      let proposals = [];
      try {
        if (fs.existsSync(proposalsPath)) {
          proposals = JSON.parse(fs.readFileSync(proposalsPath, 'utf-8'))
            .filter(p => p.status !== 'expired')
            .slice(-50);
        }
      } catch {}

      // 3. Insights summary (counts only, not full data)
      const insightsPath = path.join(os.homedir(), 'claw-projects', 'insights.json');
      let insightsSummary = { total: 0, thisWeek: 0, highScore: 0 };
      try {
        if (fs.existsSync(insightsPath)) {
          const all = JSON.parse(fs.readFileSync(insightsPath, 'utf-8'));
          insightsSummary.total = all.length;
          const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
          insightsSummary.thisWeek = all.filter(i => i.date >= weekAgo).length;
          insightsSummary.highScore = all.filter(i => (i.score || 0) >= 7 && !i.expired).length;
        }
      } catch {}

      // 4. Pipeline log (last 20 entries)
      const pipelinePath = path.join(os.homedir(), 'claw-projects', 'pipeline-log.json');
      let pipelineLog = [];
      try {
        if (fs.existsSync(pipelinePath)) {
          pipelineLog = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8')).slice(-20);
        }
      } catch {}

      // 5. Projects from IMPROVEMENT-PROJECTS.md
      const projectsFile = path.join(os.homedir(), 'claw-projects', 'IMPROVEMENT-PROJECTS.md');
      let projects = [];
      try {
        if (fs.existsSync(projectsFile)) {
          const md = fs.readFileSync(projectsFile, 'utf-8');
          let section = '';
          let current = null;
          for (const line of md.split('\n')) {
            const sectionMatch = line.match(/^# (.+)/);
            if (sectionMatch && !line.startsWith('# OpenClaw')) {
              section = sectionMatch[1].trim();
              continue;
            }
            const projMatch = line.match(/^## \[(\w+)\]\s*(.+?)\s*—\s*(.+)/);
            if (projMatch) {
              if (current) projects.push(current);
              current = { tag: projMatch[1], id: projMatch[2].trim(), title: projMatch[3].trim(), section, status: '', priority: '', lines: [] };
              continue;
            }
            if (current) {
              const priMatch = line.match(/\*?\*?(?:Prioridad|Priority)\*?\*?:\*?\*?\s*(.+)/i);
              if (priMatch) current.priority = priMatch[1].replace(/\*\*/g, '').trim();
              const statMatch = line.match(/\*?\*?(?:Estado|Status)\*?\*?:\*?\*?\s*(.+)/i);
              if (statMatch) current.status = statMatch[1].replace(/\*\*/g, '').trim();
              if (line.trim()) current.lines.push(line);
            }
          }
          if (current) projects.push(current);
          // Exclude completed-recientes and backlog sections from default view — keep active/pending
          projects = projects.filter(p => !p.section.match(/COMPLETADOS|BACKLOG|REFERENCIA|POSTERGADOS/i));
        }
      } catch {}

      // 6. Active Claude sessions (conversations)
      let sessions = [];
      try {
        sessions = getSessionsJson()
          .filter(s => s.kind === 'direct')
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .slice(0, 15);
      } catch {}

      // 7. Message threads (from message-tailer)
      let threads = [];
      try {
        const { DatabaseSync } = require('node:sqlite');
        const tdb = new DatabaseSync(antfarmDbPath, { open: true, readOnly: true });
        threads = tdb.prepare(`
          SELECT id, session_key, label, status, message_count, last_activity, first_activity, project_ids, channel
          FROM threads WHERE status != 'archived'
          ORDER BY last_activity DESC LIMIT 50
        `).all();
        tdb.close();
      } catch {}

      // 8. Spec artifacts (from specs/ directory)
      let artifacts = [];
      try {
        const specsDir = path.join(os.homedir(), '.openclaw', 'workspace', 'specs');
        if (fs.existsSync(specsDir)) {
          for (const entry of fs.readdirSync(specsDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              const specName = entry.name;
              const specPath = path.join(specsDir, specName);
              const files = fs.readdirSync(specPath).filter(f => f.endsWith('.md') && !f.startsWith('.'));
              // Extract project ID from dir name (e.g. "p88-message-queue" → "P88")
              const pidMatch = specName.match(/^p(\d+)/i);
              const projectId = pidMatch ? 'P' + pidMatch[1] : null;
              const phases = [];
              for (const f of files) {
                const base = f.replace('.md', '');
                const stat = fs.statSync(path.join(specPath, f));
                phases.push({ name: base, file: f, modified: stat.mtime.toISOString(), size: stat.size });
              }
              artifacts.push({ spec: specName, projectId, phases, path: specPath });
            } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== '.current-spec') {
              // Standalone research files
              const stat = fs.statSync(path.join(specsDir, entry.name));
              const pidMatch = entry.name.match(/^p(\d+)/i);
              const projectId = pidMatch ? 'P' + pidMatch[1] : null;
              artifacts.push({ spec: entry.name.replace('.md', ''), projectId, phases: [{ name: 'research', file: entry.name, modified: stat.mtime.toISOString(), size: stat.size }], path: path.join(specsDir, entry.name) });
            }
          }
          // Enrich artifacts without projectId using Spec: field from IMPROVEMENT-PROJECTS.md
          if (projects.length > 0) {
            const specToProject = {};
            for (const p of projects) {
              for (const line of (p.lines || [])) {
                const specMatch = line.match(/\*{0,2}Spec:\*{0,2}\s*`?([^`*(]+?)\/?`?(?:\s|\(|$)/i);
                if (specMatch && p.id) {
                  // Extract basename from full path: "~/.openclaw/workspace/specs/p80-foo/" → "p80-foo"
                  const specPath = specMatch[1].trim().replace(/\/$/, '');
                  const specName = specPath.split('/').pop();
                  if (specName) specToProject[specName] = p.id;
                }
              }
            }
            for (const a of artifacts) {
              if (!a.projectId && specToProject[a.spec]) {
                a.projectId = specToProject[a.spec];
              }
            }
          }

          artifacts.sort((a, b) => {
            const aMax = Math.max(...a.phases.map(p => new Date(p.modified).getTime()));
            const bMax = Math.max(...b.phases.map(p => new Date(p.modified).getTime()));
            return bMax - aMax;
          });
        }
      } catch {}

      // 9. Recent chat activity (last N messages from today's telegram log)
      let recentChat = { lastActivity: null, recentTopics: [], messageCount: 0 };
      try {
        const today = new Date().toISOString().slice(0, 10);
        const telegramLog = path.join(chatLogsDir, today + '-telegram.log');
        if (fs.existsSync(telegramLog)) {
          const logContent = fs.readFileSync(telegramLog, 'utf-8');
          const lines = logContent.split('\n').filter(l => l.startsWith('['));
          recentChat.messageCount = lines.length;
          // Get last 30 lines for topic extraction
          const recent = lines.slice(-30);
          // Extract timestamps from last entry
          const lastLine = recent[recent.length - 1] || '';
          const timeMatch = lastLine.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
          if (timeMatch) recentChat.lastActivity = today + 'T' + timeMatch[1];
          // Extract project mentions (P-numbers and keywords)
          const topicSet = new Set();
          for (const line of recent) {
            const pMatches = line.match(/\bP\d{2,3}\b/gi);
            if (pMatches) pMatches.forEach(p => topicSet.add(p.toUpperCase()));
            // Detect project name keywords
            if (/transporte/i.test(line)) topicSet.add('TRANSPORTE');
            if (/mission.?control|dashboard/i.test(line)) topicSet.add('DASHBOARD');
            if (/antfarm|feeder|worker/i.test(line)) topicSet.add('ANTFARM');
          }
          recentChat.recentTopics = [...topicSet];
        }
      } catch {}

      res.end(JSON.stringify({
        antfarm: { runs: antfarmRuns, steps: antfarmSteps },
        proposals,
        insights: insightsSummary,
        pipeline: pipelineLog,
        projects,
        sessions,
        threads,
        artifacts,
        recentChat,
      }));
    } catch (e) {
      res.end(JSON.stringify({ error: e.message, antfarm: { runs: [], steps: {} }, proposals: [], insights: {}, pipeline: [], sessions: [], artifacts: [] }));
    }
    return;
  }
  // --- /api/artifact — read a spec artifact file content ---
  if (req.url.startsWith('/api/artifact?')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const spec = url.searchParams.get('spec') || '';
      const file = url.searchParams.get('file') || '';
      // Sanitize: no path traversal
      if (spec.includes('..') || file.includes('..') || spec.includes('/') || file.includes('/')) {
        res.end(JSON.stringify({ error: 'Invalid path' }));
        return;
      }
      const specsDir = path.join(os.homedir(), '.openclaw', 'workspace', 'specs');
      let filePath;
      // Check if it's a directory spec or standalone file
      const dirPath = path.join(specsDir, spec);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        filePath = path.join(dirPath, file);
      } else {
        filePath = path.join(specsDir, spec + '.md');
      }
      if (!fs.existsSync(filePath)) {
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      res.end(JSON.stringify({ spec, file, content: content.substring(0, 50000) }));
    } catch (e) {
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // --- /api/messages — paginated messages by thread or project ---
  if (req.url.startsWith('/api/messages')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const sessionKey = url.searchParams.get('session_key');
      const projectId = url.searchParams.get('project');
      const proposalId = url.searchParams.get('proposal');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const before = url.searchParams.get('before'); // ISO timestamp for pagination

      const { DatabaseSync } = require('node:sqlite');
      const mdb = new DatabaseSync(antfarmDbPath, { open: true, readOnly: true });

      let messages = [];
      if (sessionKey) {
        if (before) {
          messages = mdb.prepare(
            'SELECT * FROM messages WHERE session_key = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?'
          ).all(sessionKey, before, limit);
        } else {
          messages = mdb.prepare(
            'SELECT * FROM messages WHERE session_key = ? ORDER BY created_at DESC LIMIT ?'
          ).all(sessionKey, limit);
        }
      } else if (projectId) {
        // Search messages for a specific project:
        // - From single-project threads: show ALL messages (the whole thread is about this project)
        // - From multi-project threads: only show messages with explicit project_id match
        // - Always include messages with explicit project_id match regardless of thread
        const pattern = `%${projectId}%`;

        // Separate single-project threads from multi-project threads
        const allThreads = mdb.prepare(
          'SELECT session_key, project_ids FROM threads WHERE project_ids LIKE ?'
        ).all(pattern);
        const singleProjectKeys = allThreads
          .filter(t => !t.project_ids || !t.project_ids.includes(','))
          .map(t => t.session_key);
        // Multi-project threads: only explicit project_id matches, not all messages

        // Build query: explicit project_id match OR all messages from single-project threads
        if (singleProjectKeys.length > 0) {
          const placeholders = singleProjectKeys.map(() => '?').join(',');
          if (before) {
            messages = mdb.prepare(
              'SELECT * FROM messages WHERE (project_id LIKE ? OR session_key IN (' + placeholders + ')) AND created_at < ? ORDER BY created_at DESC LIMIT ?'
            ).all(pattern, ...singleProjectKeys, before, limit);
          } else {
            messages = mdb.prepare(
              'SELECT * FROM messages WHERE (project_id LIKE ? OR session_key IN (' + placeholders + ')) ORDER BY created_at DESC LIMIT ?'
            ).all(pattern, ...singleProjectKeys, limit);
          }
        } else {
          // No single-project threads — only explicit project_id matches
          if (before) {
            messages = mdb.prepare(
              'SELECT * FROM messages WHERE project_id LIKE ? AND created_at < ? ORDER BY created_at DESC LIMIT ?'
            ).all(pattern, before, limit);
          } else {
            messages = mdb.prepare(
              'SELECT * FROM messages WHERE project_id LIKE ? ORDER BY created_at DESC LIMIT ?'
            ).all(pattern, limit);
          }
        }
      } else if (proposalId) {
        // Proposals only use chat-messages.json — skip Antfarm DB query
      } else {
        // All recent messages
        if (before) {
          messages = mdb.prepare(
            'SELECT * FROM messages WHERE created_at < ? ORDER BY created_at DESC LIMIT ?'
          ).all(before, limit);
        } else {
          messages = mdb.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT ?').all(limit);
        }
      }

      mdb.close();

      // Also check chat-messages.json for project-tagged messages (from Mission Control chat)
      if (projectId) {
        try {
          const chatMsgs = JSON.parse(fs.readFileSync(chatFile, 'utf8'));
          const prefix = '[Project: ' + projectId + ']';
          const projectChatMsgs = chatMsgs
            .filter(m => m.text && m.text.startsWith(prefix))
            .map(m => ({
              id: m.id,
              session_key: 'dashboard-chat',
              role: m.role === 'bot' ? 'assistant' : m.role || 'user',
              direction: m.role === 'user' ? 'inbound' : 'outbound',
              content: m.text.substring(prefix.length).trim(),
              created_at: m.ts,
              project_id: projectId,
              channel: 'dashboard'
            }));
          if (projectChatMsgs.length > 0) {
            messages = messages.concat(projectChatMsgs);
            // Sort by timestamp and limit
            messages.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
            if (messages.length > limit) messages = messages.slice(-limit);
          }
        } catch {}
      }

      // Also check chat-messages.json for proposal-tagged messages
      if (proposalId) {
        try {
          const chatMsgs = JSON.parse(fs.readFileSync(chatFile, 'utf8'));
          const prefix = '[Proposal: ' + proposalId + ']';
          const proposalChatMsgs = chatMsgs
            .filter(m => m.text && m.text.startsWith(prefix))
            .map(m => ({
              id: m.id,
              session_key: 'dashboard-chat',
              role: m.role === 'bot' ? 'assistant' : m.role || 'user',
              direction: m.role === 'user' ? 'inbound' : 'outbound',
              content: m.text.substring(prefix.length).trim(),
              created_at: m.ts,
              proposal_id: proposalId,
              channel: 'dashboard'
            }));
          if (proposalChatMsgs.length > 0) {
            messages = messages.concat(proposalChatMsgs);
            messages.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
            if (messages.length > limit) messages = messages.slice(-limit);
          }
        } catch {}
      }

      // Reverse to chronological order (Antfarm messages came DESC, chat messages already sorted)
      if (!projectId && !proposalId) messages.reverse();
      res.end(JSON.stringify({ messages, count: messages.length }));
    } catch (e) {
      res.end(JSON.stringify({ error: e.message, messages: [], count: 0 }));
    }
    return;
  }

  // --- /api/projects-with-messages — projects that have conversation history ---
  if (req.url === '/api/projects-with-messages') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    try {
      const { DatabaseSync } = require('node:sqlite');
      const pdb = new DatabaseSync(antfarmDbPath, { open: true, readOnly: true });
      // Get all unique project IDs from messages
      const rows = pdb.prepare('SELECT DISTINCT project_id FROM messages WHERE project_id IS NOT NULL').all();
      const projectCounts = {};
      for (const row of rows) {
        for (const pid of row.project_id.split(',')) {
          const p = pid.trim();
          if (p) projectCounts[p] = (projectCounts[p] || 0) + 1;
        }
      }
      // Get actual message counts per project
      const projects = [];
      for (const [pid, threadCount] of Object.entries(projectCounts)) {
        const msgRow = pdb.prepare(
          "SELECT COUNT(*) as c FROM messages WHERE project_id LIKE ?"
        ).get(`%${pid}%`);
        const lastRow = pdb.prepare(
          "SELECT MAX(created_at) as last_at FROM messages WHERE project_id LIKE ?"
        ).get(`%${pid}%`);
        projects.push({
          id: pid,
          messageCount: msgRow.c,
          threadCount,
          lastActivity: lastRow.last_at,
        });
      }
      projects.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
      pdb.close();
      res.end(JSON.stringify({ projects }));
    } catch (e) {
      res.end(JSON.stringify({ error: e.message, projects: [] }));
    }
    return;
  }

  // ===== END CONTROL API =====

  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' });
    res.end(html);
  } catch (e) {
    res.writeHead(500);
    res.end('Error loading dashboard');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Dashboard: http://0.0.0.0:' + PORT);
  // Usage scrape on-demand only (triggered via API)
});
