const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

function message(provider, model, usage, timestamp) {
  return JSON.stringify({ type: 'message', timestamp, message: { role: 'assistant', provider, model, usage, content: 'Fixture response' } }) + '\n';
}

test('cost APIs preserve estimates, reported totals and unknown pricing across reset files and time windows', { timeout: 30000 }, async t => {
  const temporaryRoot = path.resolve(process.env.OPENCLAW_TEST_TMP || os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'openclaw-cost-api-'));
  const workspace = path.join(directory, 'workspace');
  const openclaw = path.join(directory, 'openclaw');
  const sessionsDirectory = path.join(openclaw, 'agents', 'main', 'sessions');
  await fs.mkdir(workspace);
  await fs.mkdir(sessionsDirectory, { recursive: true });
  const preload = path.join(directory, 'preload.cjs');
  // Exercise the actual HTTP/auth/pricing code without invoking host service commands.
  await fs.writeFile(preload, "require('node:child_process').execSync = () => '';\n");
  const recent = new Date(Date.now() - 60000).toISOString();
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  const customKey = 'custom-fixture/claude-opus-4-6';
  const unknownKey = 'private/model-with-no-rate';
  const reportedKey = 'private/reported-model';
  const cacheKey = 'anthropic/claude-opus-4-6';
  const openaiKey = 'openai/gpt-4o-mini';
  const files = {
    'custom.jsonl': message('custom-fixture', 'claude-opus-4.6', { input: 1000000, output: 0, cost: { total: 0 } }, recent),
    'custom.jsonl.reset.12345': message('custom-fixture', 'claude-opus-4.6', { input: 1000000, output: 0 }, old),
    'unknown.jsonl': message('private', 'model-with-no-rate', { input: 100, output: 0, cost: { total: 0 } }, recent),
    'unknown.jsonl.reset.12345': message('private', 'model-with-no-rate', { input: 100, output: 0 }, old),
    'reported.jsonl': message('private', 'reported-model', { input: 1000, output: 50, cost: { total: 7.25 } }, recent),
    'cached.jsonl': message('anthropic', 'claude-opus-4-6', {
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000000,
      cache_creation: { ephemeral_1h_input_tokens: 1000000 }
    }, recent),
    'openai.jsonl': message('openai', 'gpt-4o-mini', {
      input_tokens: 1000000, output_tokens: 0, input_tokens_details: { cached_tokens: 500000 }
    }, recent)
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(sessionsDirectory, name), content);
  const sessions = Object.fromEntries(['custom', 'unknown', 'reported', 'cached', 'openai'].map(id => [
    'agent:main:' + id, { sessionId: id, label: id, updatedAt: Date.now(), model: id === 'custom' ? 'claude-opus-4.6' : id }
  ]));
  await fs.writeFile(path.join(sessionsDirectory, 'sessions.json'), JSON.stringify(sessions));
  let child;
  let exited;
  t.after(async () => {
    if (child) {
      child.kill();
      await exited;
    }
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot, 'Cleanup stays inside the selected temporary root');
    await fs.rm(directory, { recursive: true, force: true });
  });
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: String(port),
      DASHBOARD_TOKEN: 'cost-api-test-recovery', DASHBOARD_MFA_SECRET: '',
      DASHBOARD_AUTH_DIR: path.join(directory, 'auth'), WORKSPACE_DIR: workspace,
      OPENCLAW_DIR: openclaw, OPENCLAW_AGENT: 'main', OPENCLAW_CONFIG: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  exited = once(child, 'exit');
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(base + '/api/health')).status === 200) { ready = true; break; }
    } catch {}
    if (child.exitCode !== null) throw new Error('Fixture server exited: ' + output);
    await delay(50);
  }
  assert.ok(ready, 'Fixture server did not start: ' + output);
  for (const route of ['/api/sessions', '/api/costs', '/api/usage', '/api/lifetime-stats']) {
    assert.equal((await fetch(base + route)).status, 401, route + ' requires authentication');
  }
  const registration = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'cost-tester', password: 'Cost-test-password-123!' })
  });
  assert.equal(registration.status, 200);
  const { sessionToken } = await registration.json();
  const headers = { Authorization: 'Bearer ' + sessionToken };
  async function get(route) {
    const response = await fetch(base + route, { headers });
    assert.equal(response.status, 200, route);
    return response.json();
  }
  const sessionRows = await get('/api/sessions');
  const bySession = Object.fromEntries(sessionRows.map(row => [row.sessionId, row]));
  assert.equal(bySession.custom.cost, 10, 'Active and reset files contribute to the same session');
  assert.equal(bySession.custom.costKnown, true);
  assert.equal(bySession.unknown.cost, 0);
  assert.equal(bySession.unknown.costKnown, false, 'Unknown pricing is distinguishable from zero cost');
  assert.equal(bySession.unknown.unpricedMessages, 2);
  assert.equal(bySession.reported.cost, 7.25);
  assert.equal(bySession.reported.costKnown, true, 'Reported cost stays usable without a catalog entry');
  assert.equal(bySession.cached.cost, 10, 'One-hour cache creation uses its own rate');
  assert.equal(bySession.openai.cost, 0.11);
  const costs = await get('/api/costs');
  assert.equal(costs.total, 27.36);
  assert.equal(costs.week, 22.36, 'Ten-day-old reset costs are outside the weekly window');
  assert.equal(costs.perModel[customKey], 10);
  assert.equal(costs.perModel[unknownKey], 0);
  assert.equal(costs.perModel[reportedKey], 7.25);
  assert.equal(costs.unpricedMessages, 2);
  assert.equal(costs.unpricedPerModel[unknownKey], 2);
  assert.equal(costs.perSession.custom.cost, 10);
  assert.equal(costs.perSession.unknown.costKnown, false);
  assert.equal(costs.perSession.unknown.unpricedMessages, 2);
  const usage = await get('/api/usage');
  const perModel = usage.fiveHour.perModel;
  const breakdown = usage.fiveHour.perModelCost;
  assert.equal(usage.current.totalCost, 22.36);
  assert.equal(usage.current.totalCalls, 5);
  assert.equal(usage.unpricedMessages, 1, 'Usage counts only the current five-hour window');
  assert.equal(perModel[customKey].cost, 5, 'One million custom-provider Opus input tokens cost five dollars');
  assert.equal(perModel[customKey].input, 1000000);
  assert.equal(perModel[customKey].costKnown, true);
  assert.equal(breakdown[customKey].inputCost, 5);
  assert.equal(breakdown[customKey].totalCost, 5);
  assert.equal(breakdown[customKey].breakdownKnown, true);
  assert.equal(perModel[unknownKey].cost, 0);
  assert.equal(perModel[unknownKey].costKnown, false);
  assert.equal(perModel[unknownKey].unpricedMessages, 1);
  assert.equal(breakdown[unknownKey].costKnown, false);
  assert.equal(breakdown[unknownKey].breakdownKnown, false);
  assert.equal(breakdown[reportedKey].totalCost, 7.25);
  assert.equal(breakdown[reportedKey].costKnown, true);
  assert.equal(breakdown[reportedKey].breakdownKnown, false);
  assert.equal(breakdown[reportedKey].inputCost + breakdown[reportedKey].outputCost + breakdown[reportedKey].cacheReadCost + breakdown[reportedKey].cacheWriteCost, 0, 'Do not invent components for a reported total');
  assert.equal(breakdown[cacheKey].cacheWriteCost, 10);
  assert.equal(breakdown[cacheKey].totalCost, 10);
  assert.equal(perModel[cacheKey].cacheWrite, 1000000);
  assert.equal(perModel[openaiKey].input, 500000, 'Raw OpenAI input excludes already counted cache reads');
  assert.equal(perModel[openaiKey].cacheRead, 500000);
  assert.equal(breakdown[openaiKey].inputCost, 0.075);
  assert.equal(breakdown[openaiKey].cacheReadCost, 0.0375);
  assert.equal(usage.weekly.perModel[customKey].cost, 5);
  const lifetime = await get('/api/lifetime-stats');
  assert.equal(lifetime.totalCost, 27.36);
  assert.equal(lifetime.totalMessages, 7);
  assert.equal(lifetime.totalSessions, 5, 'Reset files belong to their original logical sessions');
  assert.equal(lifetime.totalTokens, 4001250, 'Normalized, raw and cached token formats share one accounting path');
  assert.equal(lifetime.unpricedMessages, 2);
});
