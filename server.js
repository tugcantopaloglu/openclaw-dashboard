const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const crypto = require('crypto');

const PORT = parseInt(process.env.DASHBOARD_PORT || '7000');
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.env.OPENCLAW_WORKSPACE || process.cwd();
const AGENT_ID = process.env.OPENCLAW_AGENT || 'main';
const sessDir = path.join(OPENCLAW_DIR, 'agents', AGENT_ID, 'sessions');
const cronFile = path.join(OPENCLAW_DIR, 'cron', 'jobs.json');
const dataDir = path.join(WORKSPACE_DIR, 'data');
const memoryDir = path.join(WORKSPACE_DIR, 'memory');
const memoryMdPath = path.join(WORKSPACE_DIR, 'MEMORY.md');
const heartbeatPath = path.join(WORKSPACE_DIR, 'HEARTBEAT.md');
const healthHistoryFile = path.join(dataDir, 'health-history.json');
const auditLogPath = '/root/clawd/data/audit.log';
const credentialsFile = '/root/clawd/data/credentials.json';
const mfaSecretFile = '/root/clawd/data/mfa-secret.txt';

const skillsDir = path.join(WORKSPACE_DIR, 'skills');
const configFiles = [
  { name: 'openclaw-gateway.service', path: path.join(os.homedir(), '.config/systemd/user/openclaw-gateway.service') },
  { name: 'openclaw-config.json',     path: path.join(os.homedir(), '.openclaw/config.json') },
];
const workspaceFilenames = ['AGENTS.md','HEARTBEAT.md','IDENTITY.md','MEMORY.md','SOUL.md','TOOLS.md','USER.md'];
const claudeUsageFile = path.join(dataDir, 'claude-usage.json');
const scrapeScript = path.join(WORKSPACE_DIR, 'scripts', 'scrape-claude-usage.sh');

const htmlPath = path.join(__dirname, 'index.html');

try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
try { fs.mkdirSync(path.dirname(auditLogPath), { recursive: true }); } catch {}
try { fs.mkdirSync(path.dirname(credentialsFile), { recursive: true }); } catch {}

let DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
if (!DASHBOARD_TOKEN) {
  DASHBOARD_TOKEN = crypto.randomBytes(16).toString('hex');
}

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  🔐 Recovery Token');
console.log('═══════════════════════════════════════════════════════════');
console.log('');
console.log('  ' + DASHBOARD_TOKEN);
console.log('');
console.log('  Use this token to reset your password if forgotten.');
console.log('  Set DASHBOARD_TOKEN env variable for a custom token.');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

let MFA_SECRET = process.env.DASHBOARD_MFA_SECRET;
if (!MFA_SECRET && fs.existsSync(mfaSecretFile)) {
  try {
    MFA_SECRET = fs.readFileSync(mfaSecretFile, 'utf8').trim();
  } catch {}
}

const sessions = new Map();
const SESSION_ACTIVITY_TIMEOUT = 30 * 60 * 1000;
const SESSION_REMEMBER_LIFETIME = 3 * 60 * 60 * 1000;

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const result = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(result), Buffer.from(hash));
}

function getCredentials() {
  try {
    if (!fs.existsSync(credentialsFile)) return null;
    return JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
  } catch {
    return null;
  }
}

function saveCredentials(creds) {
  const tmp = credentialsFile + '.tmp.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), 'utf8');
  fs.renameSync(tmp, credentialsFile);
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(username, ip, rememberMe = false) {
  const token = generateSessionToken();
  const now = Date.now();
  const expiresAt = now + (rememberMe ? SESSION_REMEMBER_LIFETIME : SESSION_ACTIVITY_TIMEOUT);
  sessions.set(token, {
    username,
    ip,
    createdAt: now,
    lastActivity: now,
    expiresAt,
    rememberMe
  });
  return token;
}

function validatePassword(password) {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-zA-Z]/.test(password)) return 'Password must contain at least 1 letter';
  if (!/\d/.test(password)) return 'Password must contain at least 1 number';
  return null;
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.toUpperCase().replace(/=+$/, '')) {
    const val = alphabet.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, '0');
  }
  let result = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.substring(i, i + 5).padEnd(5, '0');
    result += alphabet[parseInt(chunk, 2)];
  }
  return result;
}

function generateTOTP(secret, timeStep = 30, digits = 6, window = 0) {
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / timeStep) + window;
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter & 0xFFFFFFFF, 4);
  
  const decodedSecret = base32Decode(secret);
  const hmac = crypto.createHmac('sha1', decodedSecret);
  hmac.update(counterBuffer);
  const hash = hmac.digest();
  
  const offset = hash[hash.length - 1] & 0x0f;
  const binary = ((hash[offset] & 0x7f) << 24) | ((hash[offset + 1] & 0xff) << 16) | ((hash[offset + 2] & 0xff) << 8) | (hash[offset + 3] & 0xff);
  const otp = binary % (10 ** digits);
  return otp.toString().padStart(digits, '0');
}

function verifyTOTP(secret, code) {
  for (let w = -1; w <= 1; w++) {
    if (generateTOTP(secret, 30, 6, w) === code) return true;
  }
  return false;
}

const rateLimitStore = new Map();
const pendingMfaSecrets = new Map();
const MAX_FILE_BODY = 1024 * 1024;
const READ_ONLY_FILES = new Set(['openclaw-gateway.service', 'openclaw-config.json']);

function auditLog(event, ip, details = {}) {
  try {
    const timestamp = new Date().toISOString();
    const entry = JSON.stringify({ timestamp, event, ip, ...details }) + '\n';
    fs.appendFileSync(auditLogPath, entry, 'utf8');
    const stats = fs.statSync(auditLogPath);
    if (stats.size > 10 * 1024 * 1024) {
      const lines = fs.readFileSync(auditLogPath, 'utf8').split('\n');
      const keep = lines.slice(-5000).join('\n');
      const tmpPath = auditLogPath + '.tmp';
      fs.writeFileSync(tmpPath, keep, 'utf8');
      fs.renameSync(tmpPath, auditLogPath);
    }
  } catch {}
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function setSameSiteCORS(req, res) {
  const origin = req.headers.origin || req.headers.referer;
  const host = req.headers.host;
  if (origin && origin.includes(host)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    const proto = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    res.setHeader('Access-Control-Allow-Origin', `${proto}://${host}`);
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  const attempts = rateLimitStore.get(ip) || [];
  const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
  rateLimitStore.set(ip, recent);
  if (recent.length >= 20) {
    const lastAttempt = recent[recent.length - 1];
    const lockoutRemaining = Math.ceil((15 * 60 * 1000 - (now - lastAttempt)) / 1000);
    return { blocked: true, softLocked: true, remainingSeconds: lockoutRemaining };
  }
  if (recent.length >= 5) {
    const lastAttempt = recent[recent.length - 1];
    const lockoutRemaining = Math.ceil((15 * 60 * 1000 - (now - lastAttempt)) / 1000);
    return { blocked: false, softLocked: true, remainingSeconds: lockoutRemaining };
  }
  return { blocked: false, softLocked: false };
}

function recordFailedAuth(ip) {
  const now = Date.now();
  const attempts = rateLimitStore.get(ip) || [];
  attempts.push(now);
  rateLimitStore.set(ip, attempts);
}

function clearFailedAuth(ip) {
  rateLimitStore.delete(ip);
}

function getClientIP(req) {
  return req.socket.remoteAddress || 'unknown';
}

function isLocalhost(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isTailscaleIP(ip) {
  const clean = ip.replace('::ffff:', '');
  return clean.startsWith('100.') && parseInt(clean.split('.')[1]) >= 64 && parseInt(clean.split('.')[1]) <= 127;
}

function httpsEnforcement(req, res) {
  if (process.env.DASHBOARD_ALLOW_HTTP === 'true') return true;
  const ip = getClientIP(req);
  if (isLocalhost(ip)) return true;
  if (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') return true;
  setSecurityHeaders(res);
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end('HTTPS required. Access via localhost, Tailscale, or enable HTTPS.');
  return false;
}

function isAuthenticated(req) {
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    const url = new URL(req.url, 'http://localhost');
    token = url.searchParams.get('token');
  }
  if (!token) return false;
  
  const session = sessions.get(token);
  if (!session) return false;
  
  const now = Date.now();
  if (now > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  
  if (!session.rememberMe) {
    if (now - session.lastActivity > SESSION_ACTIVITY_TIMEOUT) {
      sessions.delete(token);
      return false;
    }
    session.lastActivity = now;
  }
  
  return true;
}

function requireAuth(req, res) {
  const ip = getClientIP(req);
  const limitCheck = checkRateLimit(ip);
  if (limitCheck.blocked) {
    setSecurityHeaders(res);
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many failed attempts', retryAfter: limitCheck.remainingSeconds }));
    return false;
  }
  
  if (!isAuthenticated(req)) {
    const sanitizedUrl = req.url.replace(/token=[^&]+/g, 'token=REDACTED');
    setSecurityHeaders(res);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

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
        const cronPart = key.split('cron:')[1] || '';
        const cronUuid = cronPart.split(':')[0];
        const job = jobs.find(j => j.id === cronUuid);
        if (job && job.name) return job.name;
      }
    } catch {}
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

function getCostData() {
  try {
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    const perModel = {};
    const perDay = {};
    const perSession = {};
    let total = 0;

    for (const file of files) {
      const sid = file.replace('.jsonl', '');
      let scost = 0;
      const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'message') continue;
          const msg = d.message;
          if (!msg || !msg.usage || !msg.usage.cost) continue;
          const c = msg.usage.cost.total || 0;
          if (c <= 0) continue;
          const model = msg.model || 'unknown';
          if (model.includes('delivery-mirror')) continue;
          const ts = d.timestamp || '';
          const day = ts.substring(0, 10);
          perModel[model] = (perModel[model] || 0) + c;
          perDay[day] = (perDay[day] || 0) + c;
          scost += c;
          total += c;
        } catch {}
      }
      if (scost > 0) perSession[sid] = scost;
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
                  if (del) { }
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
    const files = fs.readdirSync(sessDir).filter(f => {
      if (!f.endsWith('.jsonl')) return false;
      try { return fs.statSync(path.join(sessDir, f)).mtimeMs > now - oneWeekMs; } catch { return false; }
    });

    const perModel5h = {};
    const perModelWeek = {};
    const recentMessages = [];

    for (const file of files) {
      const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'message') continue;
          const msg = d.message;
          if (!msg || !msg.usage) continue;
          const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
          if (!ts) continue;
          const model = msg.model || 'unknown';
          const inTok = (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0);
          const outTok = msg.usage.output || 0;
          const cost = msg.usage.cost ? msg.usage.cost.total || 0 : 0;

          if (now - ts < fiveHoursMs) {
            if (!perModel5h[model]) perModel5h[model] = { input: 0, output: 0, cost: 0, calls: 0 };
            perModel5h[model].input += inTok;
            perModel5h[model].output += outTok;
            perModel5h[model].cost += cost;
            perModel5h[model].calls++;
          }
          if (now - ts < oneWeekMs) {
            if (!perModelWeek[model]) perModelWeek[model] = { input: 0, output: 0, cost: 0, calls: 0 };
            perModelWeek[model].input += inTok;
            perModelWeek[model].output += outTok;
            perModelWeek[model].cost += cost;
            perModelWeek[model].calls++;
          }
          if (now - ts < fiveHoursMs) {
            recentMessages.push({ ts, model, input: inTok, output: outTok, cost });
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
      const isOpus = model.includes('opus');
      const isSonnet = model.includes('sonnet');
      let inputPrice = 0, outputPrice = 0, cachePrice = 0;
      if (isOpus) { inputPrice = 15; outputPrice = 75; cachePrice = 1.875; }
      else if (isSonnet) { inputPrice = 3; outputPrice = 15; cachePrice = 0.375; }
      perModelCost5h[model] = {
        inputCost: (data.input || 0) / 1000000 * inputPrice,
        outputCost: (data.output || 0) / 1000000 * outputPrice,
        totalCost: data.cost || 0
      };
    }

    const totalCost5h = Object.values(perModel5h).reduce((s, m) => s + (m.cost || 0), 0);
    const totalCalls5h = Object.values(perModel5h).reduce((s, m) => s + (m.calls || 0), 0);
    const costLimit = 35.0;
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

function getMemoryStats() {
  const totalMem = os.totalmem();
  if (process.platform !== 'darwin') {
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    return { total: totalMem, used: usedMem, free: freeMem, percent: Math.round((usedMem / totalMem) * 100) };
  }
  try {
    const { execSync } = require('child_process');
    const out = execSync('vm_stat', { encoding: 'utf8', timeout: 2000 });
    let pageSize = 4096;
    const pageSizeMatch = out.match(/page size of (\d+) bytes/);
    if (pageSizeMatch) pageSize = parseInt(pageSizeMatch[1], 10);
    const num = (name) => {
      const m = out.match(new RegExp(name + ':\\s*(\\d+)'));
      return m ? parseInt(m[1], 10) * pageSize : 0;
    };
    const free = num('Pages free');
    const active = num('Pages active');
    const inactive = num('Pages inactive');
    const wired = num('Pages wired');
    const compressed = num('Pages occupied by compressor');
    const usedMem = active + wired + (compressed || 0);
    const availMem = free + inactive;
    const usedDisplay = Math.min(usedMem, totalMem - free);
    const memPercent = totalMem > 0 ? Math.min(100, Math.round((usedDisplay / totalMem) * 100)) : 0;
    return {
      total: totalMem,
      used: usedDisplay,
      free: free,
      percent: memPercent
    };
  } catch (e) {
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    return { total: totalMem, used: usedMem, free: freeMem, percent: Math.round((usedMem / totalMem) * 100) };
  }
}

function getSystemStats() {
  try {
    const mem = getMemoryStats();
    const totalMem = mem.total;
    const usedMem = mem.used;
    const freeMem = mem.free;
    const memPercent = mem.percent;

    let cpuTemp = null;
    if (process.platform === 'linux') {
      try {
        const tempRaw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
        cpuTemp = parseInt(tempRaw, 10) / 1000;
      } catch {}
    } else if (process.platform === 'darwin') {
      try {
        const { execSync } = require('child_process');
        const out = execSync('osx-cpu-temp 2>/dev/null || true', { encoding: 'utf8', timeout: 2000 }).trim();
        const match = out.match(/(\d+(?:\.\d+)?)/);
        if (match) cpuTemp = parseFloat(match[1]);
      } catch {}
    }

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
      if (process.platform === 'darwin') {
        const df = execSync("df -g / | tail -1", { encoding: 'utf8' }).trim();
        const parts = df.split(/\s+/).filter(Boolean);
        if (parts.length >= 5) {
          const totalGB = parseInt(parts[1], 10) || 0;
          const usedGB = parseInt(parts[2], 10) || 0;
          const pctStr = parts[4].replace('%', '');
          diskPercent = parseInt(pctStr, 10) || 0;
          diskUsed = usedGB + 'G';
          diskTotal = totalGB + 'G';
        }
      } else {
        const df = execSync("df / --output=pcent,used,size -B1G | tail -1", { encoding: 'utf8' }).trim();
        const parts = df.split(/\s+/);
        diskPercent = parseInt(parts[0], 10) || 0;
        diskUsed = (parts[1] || '') + 'G';
        diskTotal = (parts[2] || '') + 'G';
      }
    } catch {}

    let crashCount = 0;
    let crashesToday = 0;
    if (process.platform === 'linux') {
      try {
        const { execSync } = require('child_process');
        const logs = execSync("journalctl -u openclaw --since '7 days ago' --no-pager -o short 2>/dev/null | grep -ci 'SIGABRT\\|SIGSEGV\\|exit code [1-9]\\|process crashed\\|fatal error' || echo 0", { encoding: 'utf8' }).trim();
        crashCount = parseInt(logs, 10) || 0;
      } catch {}
      try {
        const { execSync } = require('child_process');
        const logs = execSync("journalctl -u openclaw --since today --no-pager -o short 2>/dev/null | grep -ci 'SIGABRT\\|SIGSEGV\\|exit code [1-9]\\|process crashed\\|fatal error' || echo 0", { encoding: 'utf8' }).trim();
        crashesToday = parseInt(logs, 10) || 0;
      } catch {}
    }

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
const _fileWatchers = {};
const _fileSizes = {};

function watchSessionFile(file) {
  const filePath = path.join(sessDir, file);
  const sessionKey = file.replace('.jsonl', '');
  if (_fileWatchers[file]) return;
  try {
    _fileSizes[file] = fs.statSync(filePath).size;
  } catch { _fileSizes[file] = 0; }
  
  try {
    _fileWatchers[file] = fs.watch(filePath, (eventType) => {
      if (eventType !== 'change') return;
      try {
        const stats = fs.statSync(filePath);
        if (stats.size <= (_fileSizes[file] || 0)) return;
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.allocUnsafe(stats.size - (_fileSizes[file] || 0));
        fs.readSync(fd, buffer, 0, buffer.length, _fileSizes[file] || 0);
        fs.closeSync(fd);
        _fileSizes[file] = stats.size;
        buffer.toString('utf8').split('\n').filter(l => l.trim()).forEach(line => {
          try { const data = JSON.parse(line); data._sessionKey = sessionKey; broadcastLiveEvent(data); } catch {}
        });
      } catch {}
    });
  } catch {}
}

function startLiveWatcher() {
  if (liveWatcher) return;
  try {
    fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')).forEach(watchSessionFile);
    liveWatcher = fs.watch(sessDir, (eventType, filename) => {
      if (filename && filename.endsWith('.jsonl') && !_fileWatchers[filename]) {
        try { if (fs.existsSync(path.join(sessDir, filename))) watchSessionFile(filename); } catch {}
      }
    });
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
  
  if (data.type === 'message') {
    const msg = data.message;
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

  if (os.platform() === 'linux') {
    return services.map(name => {
      try {
        const status = execSync(`systemctl is-active ${name} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
        return { name, active: status === 'active' };
      } catch { return { name, active: false }; }
    });
  }

  if (os.platform() === 'darwin') {
    const gatewayUrl = process.env.GATEWAY_DASHBOARD_URL || 'http://localhost:18789';
    let agentDashboardActive = false;
    try {
      const code = execSync(`curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 --max-time 3 "${gatewayUrl}" 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
      agentDashboardActive = code.length >= 1 && (code[0] === '2' || code[0] === '3');
    } catch { }

    let tailscaledActive = false;
    const tailscalePaths = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale'];
    for (const t of tailscalePaths) {
      try {
        execSync(`${t} status 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
        tailscaledActive = true;
        break;
      } catch { }
    }

    let listOut = '';
    try {
      listOut = execSync('launchctl list 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
    } catch { listOut = ''; }
    const runningLabels = new Set();
    for (const line of listOut.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const cols = trimmed.split(/\s+/);
      const pid = cols[0];
      const label = cols.length >= 3 ? cols[cols.length - 1] : '';
      if (pid !== '-' && pid !== '0' && label) runningLabels.add(label.toLowerCase());
    }
    const openclawActive = Array.from(runningLabels).some(label =>
      label === 'openclaw' || label.includes('openclaw')
    );

    return services.map(name => {
      if (name === 'agent-dashboard') return { name, active: agentDashboardActive };
      if (name === 'tailscaled') return { name, active: tailscaledActive };
      return { name, active: openclawActive };
    });
  }

  return services.map(name => ({ name, active: null }));
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

function getKeyFiles() {
  const files = [];
  for (const fname of workspaceFilenames) {
    const fpath = path.join(WORKSPACE_DIR, fname);
    try {
      if (fs.existsSync(fpath)) {
        const stat = fs.statSync(fpath);
        files.push({ name: fname, modified: stat.mtimeMs, size: stat.size, editable: true });
      }
    } catch {}
  }
  try {
    if (fs.existsSync(skillsDir)) {
      const entries = fs.readdirSync(skillsDir).sort();
      for (const e of entries) {
        const entryPath = path.join(skillsDir, e);
        try {
          const stat = fs.statSync(entryPath);
          if (stat.isDirectory()) {
            const skillMd = path.join(entryPath, 'SKILL.md');
            if (fs.existsSync(skillMd)) {
              const fstat = fs.statSync(skillMd);
              files.push({ name: 'skills/' + e + '/SKILL.md', modified: fstat.mtimeMs, size: fstat.size, editable: true });
            }
          } else if (e.endsWith('.md')) {
            files.push({ name: 'skills/' + e, modified: stat.mtimeMs, size: stat.size, editable: true });
          }
        } catch {}
      }
    }
  } catch {}
  for (const cf of configFiles) {
    try {
      if (fs.existsSync(cf.path)) {
        const stat = fs.statSync(cf.path);
        files.push({ name: cf.name, modified: stat.mtimeMs, size: stat.size, editable: !READ_ONLY_FILES.has(cf.name) });
      }
    } catch {}
  }
  return files;
}

function buildKeyFilesAllowed() {
  const map = {};
  for (const fname of workspaceFilenames) {
    const fpath = path.join(WORKSPACE_DIR, fname);
    if (fs.existsSync(fpath)) map[fname] = fpath;
  }
  try {
    if (fs.existsSync(skillsDir)) {
      for (const e of fs.readdirSync(skillsDir).sort()) {
        const ep = path.join(skillsDir, e);
        const stat = fs.statSync(ep);
        if (stat.isDirectory()) {
          const sm = path.join(ep, 'SKILL.md');
          if (fs.existsSync(sm)) map['skills/' + e + '/SKILL.md'] = sm;
        } else if (e.endsWith('.md')) {
          map['skills/' + e] = ep;
        }
      }
    }
  } catch {}
  for (const cf of configFiles) {
    if (fs.existsSync(cf.path)) map[cf.name] = cf.path;
  }
  return map;
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

setInterval(saveHealthSnapshot, 5 * 60 * 1000);
saveHealthSnapshot();

setInterval(() => {
  const now = Date.now();
  for (const [token, sess] of sessions.entries()) {
    if (now > sess.expiresAt) {
      sessions.delete(token);
    } else if (!sess.rememberMe && now - sess.lastActivity > SESSION_ACTIVITY_TIMEOUT) {
      sessions.delete(token);
    }
  }
}, 60 * 1000);

const server = http.createServer((req, res) => {
  if (!httpsEnforcement(req, res)) return;
  setSecurityHeaders(res);
  // Prevent mobile Safari from serving stale dashboard/API responses.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const ip = getClientIP(req);

  if (req.method === 'OPTIONS') {
    setSameSiteCORS(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/api/auth/status') {
    const creds = getCredentials();
    const registered = !!creds;
    const loggedIn = isAuthenticated(req);
    setSameSiteCORS(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ registered, loggedIn }));
    return;
  }

  if (req.url === '/api/auth/register' && req.method === 'POST') {
    const creds = getCredentials();
    if (creds) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Already registered' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        if (!username || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Username and password required' }));
          return;
        }

        const pwdError = validatePassword(password);
        if (pwdError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: pwdError }));
          return;
        }

        const { hash, salt } = hashPassword(password);
        const newCreds = { username, passwordHash: hash, salt, iterations: 100000 };
        saveCredentials(newCreds);

        const sessionToken = createSession(username, ip, false);
        clearFailedAuth(ip);
        auditLog('register', ip, { username });
        setSameSiteCORS(req, res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, sessionToken }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  if (req.url === '/api/auth/login' && req.method === 'POST') {
    const limitCheck = checkRateLimit(ip);
    if (limitCheck.softLocked) {
      auditLog('login_locked', ip, { remainingSeconds: limitCheck.remainingSeconds, hardLocked: limitCheck.blocked });
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many failed login attempts', lockoutRemaining: limitCheck.remainingSeconds }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      try {
        const { username, password, totpCode, rememberMe } = JSON.parse(body);
        const creds = getCredentials();
        if (!creds) {
          recordFailedAuth(ip);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No account registered' }));
          return;
        }

        if (username !== creds.username) {
          recordFailedAuth(ip);
          auditLog('login_failed', ip, { username });
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid username or password' }));
          return;
        }

        if (!verifyPassword(password, creds.passwordHash, creds.salt)) {
          recordFailedAuth(ip);
          auditLog('login_failed', ip, { username });
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid username or password' }));
          return;
        }

        if (MFA_SECRET || creds.mfaSecret) {
          const secret = creds.mfaSecret || MFA_SECRET;
          if (!totpCode) {
            setSameSiteCORS(req, res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ requiresMfa: true }));
            return;
          }

          if (!verifyTOTP(secret, totpCode)) {
            recordFailedAuth(ip);
            auditLog('login_mfa_failed', ip, { username });
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid TOTP code' }));
            return;
          }
        }

        const sessionToken = createSession(username, ip, rememberMe);
        clearFailedAuth(ip);
        auditLog('login_success', ip, { username });
        setSameSiteCORS(req, res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, sessionToken }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  if (req.url === '/api/auth/logout' && req.method === 'POST') {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      sessions.delete(token);
    }
    auditLog('logout', ip);
    setSameSiteCORS(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (req.url === '/api/auth/reset-password' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      try {
        const { recoveryToken, newPassword } = JSON.parse(body);
        if (!safeCompare(recoveryToken, DASHBOARD_TOKEN)) {
          recordFailedAuth(ip);
          auditLog('password_reset_failed', ip);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid recovery token' }));
          return;
        }

        const pwdError = validatePassword(newPassword);
        if (pwdError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: pwdError }));
          return;
        }

        const creds = getCredentials();
        if (!creds) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No account registered' }));
          return;
        }

        const { hash, salt } = hashPassword(newPassword);
        creds.passwordHash = hash;
        creds.salt = salt;
        saveCredentials(creds);

        sessions.clear();

        clearFailedAuth(ip);
        auditLog('password_reset_success', ip);
        setSameSiteCORS(req, res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  if (req.url === '/api/auth/change-password' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    setSameSiteCORS(req, res);

    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      try {
        const { currentPassword, newPassword } = JSON.parse(body);
        const creds = getCredentials();
        if (!creds) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No account registered' }));
          return;
        }

        if (!verifyPassword(currentPassword, creds.passwordHash, creds.salt)) {
          recordFailedAuth(ip);
          auditLog('password_change_failed', ip);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Current password is incorrect' }));
          return;
        }

        const pwdError = validatePassword(newPassword);
        if (pwdError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: pwdError }));
          return;
        }

        const { hash, salt } = hashPassword(newPassword);
        creds.passwordHash = hash;
        creds.salt = salt;
        saveCredentials(creds);

        const authHeader = req.headers.authorization;
        const currentToken = authHeader ? authHeader.substring(7) : null;
        for (const [token, sess] of sessions.entries()) {
          if (token !== currentToken) sessions.delete(token);
        }

        clearFailedAuth(ip);
        auditLog('password_change_success', ip);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  if (req.url === '/api/auth/mfa-status') {
    if (!requireAuth(req, res)) return;
    setSameSiteCORS(req, res);
    const creds = getCredentials();
    const enabled = !!(creds?.mfaSecret || MFA_SECRET);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled }));
    return;
  }

  if (req.url === '/api/auth/setup-mfa' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    setSameSiteCORS(req, res);
    
    try {
      const secret = base32Encode(crypto.randomBytes(20));
      const otpauth_uri = `otpauth://totp/OpenClaw:Dashboard?secret=${secret}&issuer=OpenClaw&algorithm=SHA1&digits=6&period=30`;
      pendingMfaSecrets.set(getClientIP(req), { secret, createdAt: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secret, otpauth_uri }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/api/auth/confirm-mfa' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    setSameSiteCORS(req, res);
    
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const { totpCode } = JSON.parse(body);
        const ip = getClientIP(req);
        const pending = pendingMfaSecrets.get(ip);
        
        if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
          pendingMfaSecrets.delete(ip);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'MFA setup expired. Please try again.' }));
          return;
        }
        
        if (!totpCode || !verifyTOTP(pending.secret, totpCode)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid TOTP code. Please try again.' }));
          return;
        }
        
        const creds = getCredentials();
        if (creds) {
          creds.mfaSecret = pending.secret;
          saveCredentials(creds);
        }
        pendingMfaSecrets.delete(ip);
        auditLog('mfa_setup', ip);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/auth/disable-mfa' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    setSameSiteCORS(req, res);
    
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const { totpCode } = JSON.parse(body);
        
        const creds = getCredentials();
        const mfaSecret = creds?.mfaSecret || MFA_SECRET;
        
        if (!mfaSecret) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'MFA is not enabled' }));
          return;
        }
        
        if (!totpCode || !verifyTOTP(mfaSecret, totpCode)) {
          auditLog('mfa_disable_failed', getClientIP(req));
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid TOTP code' }));
          return;
        }
        
        if (creds) {
          delete creds.mfaSecret;
          saveCredentials(creds);
        }
        
        auditLog('mfa_disabled', getClientIP(req));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading dashboard');
    }
    return;
  }

  if (req.url.startsWith('/api/')) {
    if (!requireAuth(req, res)) return;
    setSameSiteCORS(req, res);

    if (req.url === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getSessionsJson()));
      return;
    }
    if (req.url === '/api/usage') {
      const now = Date.now();
      if (!usageCache || now - usageCacheTime > 10000) {
        usageCache = getUsageWindows();
        usageCacheTime = now;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(usageCache));
      return;
    }
    if (req.url === '/api/costs') {
      const now = Date.now();
      if (!costCache || now - costCacheTime > 60000) {
        costCache = getCostData();
        costCacheTime = now;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(costCache));
      return;
    }
    if (req.url === '/api/system') {
      const stats = getSystemStats();
      if (stats.disk) stats.diskHistory = trackDiskHistory(stats.disk.percent || 0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages));
      return;
    }
    if (req.url === '/api/crons') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getCronJobs()));
      return;
    }
    if (req.url === '/api/git') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getGitActivity()));
      return;
    }
    if (req.url === '/api/services') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getServicesStatus()));
      return;
    }
    if (req.url === '/api/memory') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getMemoryFiles()));
      return;
    }
    if (req.url === '/api/tokens-today') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getTodayTokens()));
      return;
    }
    if (req.url === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'OpenClaw Dashboard', version: '1.0.0' }));
      return;
    }
    if (req.url === '/api/claude-usage-scrape' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (fs.existsSync(scrapeScript)) {
        exec(`bash ${scrapeScript}`, { timeout: 60000 }, (err) => {});
        res.end(JSON.stringify({ status: 'started' }));
      } else {
        res.end(JSON.stringify({ status: 'error', message: 'Scrape script not found' }));
      }
      return;
    }
    if (req.url === '/api/claude-usage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      try {
        const data = JSON.parse(fs.readFileSync(claudeUsageFile, 'utf8'));
        res.end(JSON.stringify(data));
      } catch {
        res.end(JSON.stringify({ error: 'No usage data. Run scrape-claude-usage.sh first.' }));
      }
      return;
    }
    if (req.url === '/api/response-time') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ avgSeconds: getAvgResponseTime() }));
      return;
    }
    if (req.url.startsWith('/api/logs?')) {
      try {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const allowedServices = ['openclaw', 'agent-dashboard', 'tailscaled', 'sshd', 'nginx'];
        const service = params.get('service') || 'openclaw';
        if (!allowedServices.includes(service)) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid service name');
          return;
        }
        if (process.platform !== 'linux') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Logs (journalctl) are only available on Linux.\nOn macOS use Console.app or: log show --predicate \'processImagePath contains "openclaw"\' --last 1h');
          return;
        }
        const lines = Math.min(Math.max(parseInt(params.get('lines')) || 100, 1), 1000);
        const { execSync } = require('child_process');
        const logs = execSync(`journalctl -u ${service} --no-pager -n ${lines} -o short 2>/dev/null || echo "No logs available"`, { encoding: 'utf8', timeout: 10000 });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(logs);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error fetching logs');
      }
      return;
    }
    if (req.url === '/api/action/restart-openclaw' && req.method === 'POST') {
      try {
        auditLog('action_restart_openclaw', ip);
        exec('systemctl restart openclaw', (err) => {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.url === '/api/action/restart-dashboard' && req.method === 'POST') {
      try {
        auditLog('action_restart_dashboard', ip);
        setTimeout(() => {
          exec('systemctl restart agent-dashboard', (err) => {});
        }, 2000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.url === '/api/action/restart-tailscale' && req.method === 'POST') {
      auditLog('action_restart_tailscale', ip);
      exec('systemctl restart tailscaled', (err) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: !err, error: err?.message }));
      });
      return;
    }
    if (req.url === '/api/action/update-openclaw' && req.method === 'POST') {
      auditLog('action_update_openclaw', ip);
      exec('npm update -g openclaw', { timeout: 120000 }, (err, stdout) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: !err, output: stdout?.trim(), error: err?.message }));
      });
      return;
    }
    if (req.url === '/api/action/kill-tmux' && req.method === 'POST') {
      exec('tmux kill-session -t claude-persistent 2>/dev/null; echo ok', (err, stdout) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
      return;
    }
    if (req.url === '/api/action/gc' && req.method === 'POST') {
      const projDir = path.join(WORKSPACE_DIR, 'projects');
      exec(`if [ -d "${projDir}" ]; then for d in ${projDir}/*/; do cd "$d" && git gc --quiet 2>/dev/null; done; fi; cd ${WORKSPACE_DIR} && git gc --quiet 2>/dev/null; echo ok`, (err) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
      return;
    }
    if (req.url === '/api/action/check-update' && req.method === 'POST') {
      exec('npm outdated -g openclaw 2>/dev/null || echo "up to date"', { timeout: 30000 }, (err, stdout) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, output: (stdout || '').trim() || 'All packages up to date' }));
      });
      return;
    }
    if (req.url === '/api/action/sys-update' && req.method === 'POST') {
      auditLog('action_sys_update', ip);
      exec('apt update -qq && apt upgrade -y -qq 2>&1 | tail -5', { timeout: 300000 }, (err, stdout) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: !err, output: (stdout || '').trim(), error: err?.message }));
      });
      return;
    }
    if (req.url === '/api/action/disk-cleanup' && req.method === 'POST') {
      exec('apt autoremove -y -qq 2>/dev/null; apt clean 2>/dev/null; journalctl --vacuum-time=7d 2>/dev/null; echo "Cleanup done"', { timeout: 60000 }, (err, stdout) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, output: (stdout || '').trim() }));
      });
      return;
    }
    if (req.url === '/api/action/restart-claude' && req.method === 'POST') {
      exec(`tmux kill-session -t claude-persistent 2>/dev/null; sleep 1; tmux new-session -d -s claude-persistent -x 200 -y 60 && tmux send-keys -t claude-persistent "cd ${WORKSPACE_DIR} && claude" Enter && echo "Claude session started"`, { timeout: 20000 }, (err, stdout) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: !err, output: (stdout || '').trim() }));
      });
      return;
    }
    if (req.url === '/api/tailscale') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(healthHistory));
      return;
    }
    if (req.url === '/api/memory-files') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
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
          res.writeHead(200, { 'Content-Type': 'text/plain' });
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
    if (req.url === '/api/key-files') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getKeyFiles()));
      return;
    }
    if (req.url.startsWith('/api/key-file') && req.method === 'GET') {
      try {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const name = params.get('path') || '';
        const allowed = buildKeyFilesAllowed();
        if (!allowed[name]) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }
        const fpath = allowed[name];
        if (!fs.existsSync(fpath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('File not found');
          return;
        }
        const content = fs.readFileSync(fpath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(content);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request');
      }
      return;
    }
    if (req.url === '/api/key-file' && req.method === 'POST') {
      let body = '';
      let overflow = false;
      req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_FILE_BODY) { overflow = true; req.destroy(); }
      });
      req.on('end', () => {
        if (overflow) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large (max 1MB)' }));
          return;
        }
        try {
          const { path: name, content } = JSON.parse(body);
          if (typeof name !== 'string' || typeof content !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request body' }));
            return;
          }
          if (READ_ONLY_FILES.has(name)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File is read-only' }));
            return;
          }
          const allowed = buildKeyFilesAllowed();
          if (!allowed[name]) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
          }
          const fpath = allowed[name];
          auditLog('file_edit', ip, { file: name });
          try {
            if (fs.existsSync(fpath)) {
              fs.copyFileSync(fpath, fpath + '.bak');
            }
          } catch {}
          const tmp = fpath + '.tmp.' + Date.now();
          fs.writeFileSync(tmp, content, 'utf8');
          fs.renameSync(tmp, fpath);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
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
          auditLog('cron_toggle', ip, { cronId: id, enabled: job.enabled });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, enabled: job.enabled }));
        } else if (action === 'run') {
          exec(`openclaw cron run ${id}`, { timeout: 60000 }, (err) => {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
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
    if (req.url === '/api/live' || req.url.startsWith('/api/live?')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      
      liveClients.push(res);
      startLiveWatcher();
      
      res.write('data: {"status":"connected"}\n\n');
      
      try {
        const cutoff = Date.now() - 3600000;
        const files = fs.readdirSync(sessDir).filter(f => {
          if (!f.endsWith('.jsonl')) return false;
          try { return fs.statSync(path.join(sessDir, f)).mtimeMs > cutoff; } catch { return false; }
        });
        const recentEvents = [];
        files.forEach(file => {
          const sessionKey = file.replace('.jsonl', '');
          const content = fs.readFileSync(path.join(sessDir, file), 'utf8');
          const lines = content.split('\n').filter(l => l.trim());
          lines.slice(-5).forEach(line => {
            try {
              const data = JSON.parse(line);
              data._sessionKey = sessionKey;
              const event = formatLiveEvent(data);
              if (event) recentEvents.push(event);
            } catch {}
          });
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
  }

  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (e) {
    res.writeHead(500);
    res.end('Error loading dashboard');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Dashboard: http://0.0.0.0:' + PORT);
});
