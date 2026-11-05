const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const base = process.env.DASHBOARD_SMOKE_URL || 'http://127.0.0.1:3001';
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok && (await response.json()).status === 'ok') {
        ready = true;
        break;
      }
    } catch {}
    await delay(500);
  }
  assert.ok(ready, 'Container health endpoint must be reachable through the published port');
  assert.equal((await fetch(base + '/api/sessions')).status, 401);
  const registration = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'docker-smoke', password: 'Disposable-smoke-password-123!' })
  });
  assert.equal(registration.status, 200);
  const { sessionToken } = await registration.json();
  assert.equal(typeof sessionToken, 'string');
  const headers = { Authorization: 'Bearer ' + sessionToken };
  const sessions = await fetch(base + '/api/sessions', { headers });
  assert.equal(sessions.status, 200);
  assert.deepEqual(await sessions.json(), []);
  const costs = await fetch(base + '/api/costs', { headers });
  assert.equal(costs.status, 200);
  assert.equal((await costs.json()).total, 0);
  const config = await fetch(base + '/api/openclaw-config', { headers });
  assert.equal(config.status, 403);
  assert.equal((await config.json()).code, 'REAUTH_REQUIRED');
  console.log('Docker smoke passed: published port, health, authentication, pricing and reauthentication gate');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
