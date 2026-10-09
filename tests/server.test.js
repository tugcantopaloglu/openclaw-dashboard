const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

test('server authentication and bounded audit notifications', { timeout: 20000 }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-test-'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DASHBOARD_PORT: String(port), WORKSPACE_DIR: workspace, OPENCLAW_DIR: workspace, DASHBOARD_AUTH_DIR: workspace, DASHBOARD_TOKEN: 'integration-test-recovery-token' },
    stdio: 'ignore'
  });
  const exited = once(server, 'exit');
  const url = 'http://127.0.0.1:' + port;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(url + '/api/auth/status');
        assert.equal(response.status, 200);
        assert.equal((await response.json()).registered, false);
        ready = true;
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(ready, 'Server did not start');
    assert.equal((await fetch(url + '/api/notifications')).status, 401);
    const register = await fetch(url + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'administrator', password: 'Test-password-123!' })
    });
    assert.equal(register.status, 200);
    const { sessionToken } = await register.json();
    assert.equal(typeof sessionToken, 'string');
    const username = '<img src=x onerror=alert(1)>';
    const failedLogin = await fetch(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'invalid-password' })
    });
    assert.equal(failedLogin.status, 401);
    const headers = { Authorization: 'Bearer ' + sessionToken };
    const notification = await fetch(url + '/api/notifications?limit=1', { headers });
    const { events } = await notification.json();
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'login_failed');
    assert.equal(events[0].username, username);
    await fs.writeFile(path.join(workspace, 'audit.log'), Array.from({ length: 250 }, (_, index) => JSON.stringify({ event: 'test', index })).join('\n') + '\n');
    for (const [limit, expected] of [['-1', 50], ['0', 50], ['invalid', 50], ['500', 200], ['1', 1]]) {
      const response = await fetch(url + '/api/notifications?limit=' + limit, { headers });
      const { events: boundedEvents } = await response.json();
      assert.equal(boundedEvents.length, expected);
      assert.equal(boundedEvents[0].index, 249);
    }
  } finally {
    server.kill();
    await exited;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
