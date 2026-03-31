const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// This bridge runs on the HOST (not in Docker) and provides OpenClaw data
// to containerized services via HTTP.
const PORT = parseInt(process.env.PORT || '7002');

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || '/data/.openclaw';
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.join(OPENCLAW_DIR, 'workspace');

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

// ── /sessions ───────────────────────────────────────────────────────────────

function apiSessions(res) {
  const sessionsPath = path.join(OPENCLAW_DIR, 'agents', 'main', 'sessions', 'sessions.json');
  const raw = readJsonSafe(sessionsPath, {});
  const now = Date.now();
  const activeMinutes = 120;

  const sessions = [];
  for (const [key, s] of Object.entries(raw)) {
    const ageMs = now - (s.updatedAt || 0);
    if (ageMs > activeMinutes * 60 * 1000) continue;

    let type = 'other';
    if (key.includes(':subagent:')) type = 'subagent';
    else if (key.includes(':cron:')) type = 'cron';
    else if (key.includes(':telegram:')) type = 'telegram';
    else if (key.endsWith(':main')) type = 'main';

    sessions.push({
      key,
      type,
      agentId: s.agentId || 'main',
      model: s.model ? `${s.modelProvider || ''}/${s.model}` : null,
      contextTokens: s.contextTokens || null,
      totalTokens: s.totalTokensFresh ? s.totalTokens : null,
      updatedAt: s.updatedAt,
      ageSeconds: Math.round(ageMs / 1000),
      sessionId: s.sessionId,
      chatType: s.chatType,
    });
  }

  // Sort by updatedAt descending
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  json(res, { sessions, count: sessions.length, activeMinutes });
}

// ── /cron ───────────────────────────────────────────────────────────────────

function apiCron(res) {
  const cronPath = path.join(OPENCLAW_DIR, 'cron', 'jobs.json');
  const raw = readJsonSafe(cronPath, { jobs: [] });
  const jobs = (raw.jobs || []).map(j => ({
    id: j.id,
    name: j.name,
    enabled: j.enabled,
    schedule: j.schedule?.expr || null,
    timezone: j.schedule?.tz || null,
    sessionTarget: j.sessionTarget,
    wakeMode: j.wakeMode,
    state: j.state || {},
    createdAt: j.createdAtMs,
    updatedAt: j.updatedAtMs,
  }));

  json(res, { jobs, total: jobs.length });
}

// ── /subagents ──────────────────────────────────────────────────────────────

function apiSubagents(res) {
  const runsPath = path.join(OPENCLAW_DIR, 'subagents', 'runs.json');
  const raw = readJsonSafe(runsPath, { runs: {} });
  const now = Date.now();

  const runs = [];
  for (const [id, r] of Object.entries(raw.runs || {})) {
    // Only show recent runs (last 2 hours)
    if (r.endedAt && now - r.endedAt > 2 * 60 * 60 * 1000) continue;
    if (!r.endedAt && r.startedAt && now - r.startedAt > 2 * 60 * 60 * 1000) continue;

    runs.push({
      runId: id,
      label: r.label,
      model: r.model,
      status: r.outcome?.status || (r.endedAt ? 'ended' : 'running'),
      task: (r.task || '').substring(0, 200),
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      endedReason: r.endedReason,
      frozenResultText: (r.frozenResultText || '').substring(0, 300),
      requesterSessionKey: r.requesterSessionKey,
      childSessionKey: r.childSessionKey,
    });
  }

  runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  json(res, { runs, total: runs.length });
}

// ── /kanban ─────────────────────────────────────────────────────────────────

function apiKanban(res) {
  const kanbanPath = path.join(WORKSPACE_DIR, 'kanban.json');
  const data = readJsonSafe(kanbanPath, { columns: [], tasks: [] });
  json(res, data);
}

// ── /agents (unified) ───────────────────────────────────────────────────────

function apiAgents(res) {
  const sessionsPath = path.join(OPENCLAW_DIR, 'agents', 'main', 'sessions', 'sessions.json');
  const cronPath = path.join(OPENCLAW_DIR, 'cron', 'jobs.json');
  const runsPath = path.join(OPENCLAW_DIR, 'subagents', 'runs.json');
  const kanbanPath = path.join(WORKSPACE_DIR, 'kanban.json');

  const sessionsRaw = readJsonSafe(sessionsPath, {});
  const cronRaw = readJsonSafe(cronPath, { jobs: [] });
  const runsRaw = readJsonSafe(runsPath, { runs: {} });
  const kanban = readJsonSafe(kanbanPath, { columns: [], tasks: [] });
  const now = Date.now();

  // Sessions
  const sessions = [];
  for (const [key, s] of Object.entries(sessionsRaw)) {
    const ageMs = now - (s.updatedAt || 0);
    if (ageMs > 120 * 60 * 1000) continue;

    let type = 'other';
    if (key.includes(':subagent:')) type = 'subagent';
    else if (key.includes(':cron:')) type = 'cron';
    else if (key.includes(':telegram:')) type = 'telegram';
    else if (key.endsWith(':main')) type = 'main';

    sessions.push({
      key, type,
      agentId: s.agentId || 'main',
      model: s.model ? `${s.modelProvider || ''}/${s.model}` : null,
      totalTokens: s.totalTokensFresh ? s.totalTokens : null,
      updatedAt: s.updatedAt,
      ageSeconds: Math.round(ageMs / 1000),
    });
  }
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  // Active subagents (currently running)
  const activeSubagents = [];
  for (const [id, r] of Object.entries(runsRaw.runs || {})) {
    if (r.endedAt) continue; // skip completed
    activeSubagents.push({
      runId: id,
      label: r.label,
      model: r.model,
      task: (r.task || '').substring(0, 200),
      startedAt: r.startedAt,
      ageSeconds: Math.round((now - (r.startedAt || now)) / 1000),
    });
  }

  // Cron jobs
  const cronJobs = (cronRaw.jobs || []).map(j => ({
    id: j.id,
    name: j.name,
    enabled: j.enabled,
    schedule: j.schedule?.expr || null,
    state: j.state || {},
    updatedAt: j.updatedAtMs,
  }));

  // Kanban task summary
  const taskSummary = {};
  for (const col of kanban.columns) {
    const colTasks = kanban.tasks.filter(t => t.column === col.id);
    taskSummary[col.id] = {
      title: col.title,
      count: colTasks.length,
      tasks: colTasks.map(t => ({
        id: t.id, title: t.title, priority: t.priority, assignee: t.assignee || null,
      })),
    };
  }

  json(res, {
    generatedAt: now,
    summary: {
      totalActiveSessions: sessions.length,
      activeSubagents: activeSubagents.length,
      totalCronJobs: cronJobs.length,
      cronJobsEnabled: cronJobs.filter(j => j.enabled).length,
      kanbanTasksTotal: kanban.tasks.length,
    },
    sessions,
    activeSubagents,
    cronJobs,
    kanban: { columns: kanban.columns, taskSummary },
  });
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/api/agents' || req.url === '/') return apiAgents(req, res);
  if (req.url === '/api/sessions') return apiSessions(res);
  if (req.url === '/api/cron') return apiCron(res);
  if (req.url === '/api/subagents') return apiSubagents(res);
  if (req.url === '/api/kanban') return apiKanban(res);
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`OpenClaw data bridge on http://127.0.0.1:${PORT}`);
});
