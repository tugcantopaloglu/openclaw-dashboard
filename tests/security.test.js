const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { REAUTH_TTL_MS, hasFreshReauth, isHTTPS, isTrustedProxy, atomicWriteFileSync, resolveGitExecutable } = require('../lib/security');

const password = 'Security-test-password-123!';

async function fixture(t) {
  const temporaryRoot = path.resolve(process.env.OPENCLAW_TEST_TMP || os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'openclaw-security-'));
  const workspace = path.join(directory, 'workspace');
  const openclaw = path.join(directory, 'openclaw');
  const auth = path.join(directory, 'auth');
  await Promise.all([workspace, openclaw, auth].map(item => fs.mkdir(item)));
  await fs.writeFile(path.join(openclaw, 'openclaw.json'), '{"fixture":true}');
  const clock = path.join(directory, 'clock.json');
  await fs.writeFile(clock, '0');
  const preload = path.join(directory, 'preload.cjs');
  // The real HTTP server/auth/files run, but no host service commands are executed.
  await fs.writeFile(preload, `
    const fs = require('node:fs');
    const realNow = Date.now;
    Date.now = () => realNow() + Number(fs.readFileSync(process.env.TEST_CLOCK, 'utf8'));
    require('node:child_process').execSync = () => '';
  `);
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot, 'Cleanup stays inside the selected temporary root');
    return fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, workspace, openclaw, auth, clock, preload };
}

async function startServer(t, files, environment = {}) {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['--require', files.preload, 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, DASHBOARD_PORT: String(port), DASHBOARD_HOST: '127.0.0.1',
      WORKSPACE_DIR: files.workspace, OPENCLAW_DIR: files.openclaw,
      DASHBOARD_AUTH_DIR: files.auth, DASHBOARD_TOKEN: '', DASHBOARD_MFA_SECRET: '',
      OPENCLAW_CONFIG: '', TEST_CLOCK: files.clock, ...environment
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.kill();
    await exited;
  };
  t.after(stop);
  const base = 'http://127.0.0.1:' + port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(base + '/api/health')).status === 200) {
        return { base, stop, output: () => output };
      }
    } catch {}
    if (child.exitCode !== null) throw new Error('Fixture server exited: ' + output);
    await delay(50);
  }
  throw new Error('Fixture server did not start: ' + output);
}

function jsonRequest(server, route, token, payload, method = 'POST') {
  return fetch(server.base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(payload)
  });
}

async function register(server) {
  const response = await jsonRequest(server, '/api/auth/register', null, { username: 'administrator', password });
  assert.equal(response.status, 200);
  return (await response.json()).sessionToken;
}

async function expectReauth(server, route, token) {
  const response = await fetch(server.base + route, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 403, route);
  assert.equal((await response.json()).code, 'REAUTH_REQUIRED');
}

function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map(character => alphabet.indexOf(character).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

test('sensitive APIs require fresh authentication bound to the current session', { timeout: 30000 }, async t => {
  const files = await fixture(t);
  const server = await startServer(t, files);
  const token = await register(server);
  const routes = ['/api/openclaw-config', '/api/sys-security', '/api/key-file?path=openclaw-config.json'];
  assert.equal((await fetch(server.base + routes[0])).status, 401);
  for (const route of routes) await expectReauth(server, route, token);
  const rejectedSave = await jsonRequest(server, routes[0], token, { config: '{"bad":true}' }, 'PUT');
  assert.equal(rejectedSave.status, 403);
  assert.equal((await rejectedSave.json()).code, 'REAUTH_REQUIRED');
  assert.equal((await jsonRequest(server, '/api/reauth', token, { password })).status, 200);
  for (const route of routes) {
    assert.equal((await fetch(server.base + route, { headers: { Authorization: 'Bearer ' + token } })).status, 200);
  }
  const login = await jsonRequest(server, '/api/auth/login', null, { username: 'administrator', password });
  const secondToken = (await login.json()).sessionToken;
  await expectReauth(server, routes[0], secondToken);
  await fs.writeFile(files.clock, String(REAUTH_TTL_MS + 1000));
  await expectReauth(server, routes[0], token);
  await fs.writeFile(files.clock, '0');
  assert.equal((await jsonRequest(server, '/api/reauth', token, { password })).status, 200);
  assert.equal((await jsonRequest(server, '/api/reauth', token, { password: 'incorrect' })).status, 401);
  await expectReauth(server, routes[0], token);
  assert.equal((await jsonRequest(server, '/api/reauth', token, { password })).status, 200);
  const malformed = await fetch(server.base + '/api/reauth', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: '{' });
  assert.equal(malformed.status, 400);
  await expectReauth(server, routes[0], token);
  assert.equal((await jsonRequest(server, '/api/reauth', token, { password })).status, 200);
  const replacement = '{"fixture":"updated"}';
  const saved = await jsonRequest(server, routes[0], token, { config: replacement }, 'PUT');
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.equal(await fs.readFile(path.join(files.openclaw, 'openclaw.json'), 'utf8'), replacement);
  assert.equal(await fs.readFile(result.backup, 'utf8'), '{"fixture":true}');
  if (process.platform !== 'win32') assert.equal((await fs.stat(result.backup)).mode & 0o777, 0o600);
  assert.equal((await jsonRequest(server, '/api/reauth', secondToken, { password })).status, 200);
  const setup = await jsonRequest(server, '/api/auth/setup-mfa', token, {});
  const { secret } = await setup.json();
  const otherSessionConfirm = await jsonRequest(server, '/api/auth/confirm-mfa', secondToken, { totpCode: totp(secret) });
  assert.equal(otherSessionConfirm.status, 400, 'MFA setup is bound to its initiating session');
  const confirmed = await jsonRequest(server, '/api/auth/confirm-mfa', token, { totpCode: totp(secret) });
  assert.equal(confirmed.status, 200);
  await expectReauth(server, routes[0], token);
  await expectReauth(server, routes[0], secondToken);
  assert.equal((await jsonRequest(server, '/api/auth/setup-mfa', token, {})).status, 403, 'Replacing an existing MFA secret needs reauth');
  assert.equal((await jsonRequest(server, '/api/reauth', token, { password })).status, 401);
  assert.equal((await jsonRequest(server, '/api/reauth', token, { password, totp: totp(secret) })).status, 200);
  assert.equal((await fetch(server.base + routes[0], { headers: { Authorization: 'Bearer ' + token } })).status, 200);
  await server.stop();
});

test('recovery tokens persist in the private auth directory and env overrides are never logged', { timeout: 30000 }, async t => {
  const files = await fixture(t);
  const tokenFile = path.join(files.auth, 'recovery-token.txt');
  const first = await startServer(t, files);
  await register(first);
  const token = (await fs.readFile(tokenFile, 'utf8')).trim();
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.ok(!first.output().includes(token));
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(tokenFile)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(files.auth)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(files.auth, 'credentials.json'))).mode & 0o777, 0o600);
  }
  await first.stop();
  const second = await startServer(t, files);
  assert.equal((await fs.readFile(tokenFile, 'utf8')).trim(), token);
  assert.equal((await jsonRequest(second, '/api/auth/reset-password', null, { recoveryToken: token, newPassword: password })).status, 200);
  assert.ok(!second.output().includes(token));
  await second.stop();
  const supplied = 'environment-recovery-secret-for-test';
  const third = await startServer(t, files, { DASHBOARD_TOKEN: supplied });
  assert.equal((await jsonRequest(third, '/api/auth/reset-password', null, { recoveryToken: token, newPassword: password })).status, 401);
  assert.equal((await jsonRequest(third, '/api/auth/reset-password', null, { recoveryToken: supplied, newPassword: password })).status, 200);
  assert.equal((await fs.readFile(tokenFile, 'utf8')).trim(), token);
  assert.ok(!third.output().includes(supplied));
  assert.ok(!third.output().includes(token));
  await third.stop();
});

test('git activity accepts whitespace and shell syntax in repository paths without a shell', { timeout: 30000 }, async t => {
  const files = await fixture(t);
  const repositoryName = 'project with spaces $(echo harmless)';
  const repository = path.join(files.workspace, 'projects', repositoryName);
  await fs.mkdir(repository, { recursive: true });
  const gitExecutable = resolveGitExecutable();
  assert.ok(gitExecutable, 'Install Git in a standard location or set DASHBOARD_GIT_BIN to its absolute path');
  execFileSync(gitExecutable, ['init', repository], { stdio: 'ignore' });
  execFileSync(gitExecutable, ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'Fixture commit'], { stdio: 'ignore' });
  const server = await startServer(t, files, { DASHBOARD_GIT_BIN: gitExecutable });
  const token = await register(server);
  const response = await fetch(server.base + '/api/git', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  const commits = await response.json();
  assert.ok(commits.some(commit => commit.repo === repositoryName && commit.message === 'Fixture commit'));
  await server.stop();
  const missingGit = await startServer(t, files, { DASHBOARD_GIT_BIN: path.join(files.directory, 'missing-git') });
  const login = await jsonRequest(missingGit, '/api/auth/login', null, { username: 'administrator', password });
  const { sessionToken } = await login.json();
  const unavailableResponse = await fetch(missingGit.base + '/api/git', { headers: { Authorization: 'Bearer ' + sessionToken } });
  assert.equal(unavailableResponse.status, 200);
  assert.deepEqual(await unavailableResponse.json(), [], 'Unavailable configured Git degrades without a PATH lookup');
  await missingGit.stop();
});

test('same-origin APIs work without granting access to supplied Origin or Host headers', { timeout: 30000 }, async t => {
  const files = await fixture(t);
  const server = await startServer(t, files);
  const token = await register(server);
  const sameOrigin = await fetch(server.base + '/api/auth/status', { headers: { Authorization: 'Bearer ' + token, Origin: server.base } });
  assert.equal(sameOrigin.status, 200);
  assert.equal((await sameOrigin.json()).loggedIn, true);
  assert.equal(sameOrigin.headers.get('access-control-allow-origin'), null);
  assert.equal(sameOrigin.headers.get('vary'), 'Origin');
  for (const [origin, host] of [
    ['https://attacker.example', 'attacker.example'],
    ['https://attacker.example', new URL(server.base).host],
    ['https://dashboard.example.attacker.example', 'dashboard.example']
  ]) {
    for (const method of ['GET', 'OPTIONS']) {
      // node:http allows an explicit Host header, exercising the actual incoming request.
      const response = await new Promise((resolve, reject) => {
        const request = http.request(server.base + '/api/auth/status', { method, headers: { Host: host, Origin: origin, Authorization: 'Bearer ' + token } }, result => {
          result.resume();
          result.on('end', () => resolve({ status: result.statusCode, headers: result.headers }));
        });
        request.on('error', reject);
        request.end();
      });
      assert.equal(response.status, method === 'OPTIONS' ? 204 : 200);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.equal(response.headers.vary, 'Origin');
    }
  }
  await server.stop();
});

test('atomic write failure retains the original error and removes its temporary file', async t => {
  const files = await fixture(t);
  const destination = path.join(files.auth, 'atomic-write.txt');
  await fs.writeFile(destination, 'original');
  const original = new Error('fixture write failed');
  t.mock.method(fsSync, 'writeFileSync', () => { throw original; });
  assert.throws(() => atomicWriteFileSync(destination, 'replacement'), error => error === original);
  t.mock.restoreAll();
  assert.equal(await fs.readFile(destination, 'utf8'), 'original');
  assert.deepEqual((await fs.readdir(files.auth)).filter(name => name.includes('.tmp.')), []);
});

test('atomic write cleanup errors never mask its original failure', async t => {
  const files = await fixture(t);
  const destination = path.join(files.auth, 'atomic-cleanup.txt');
  const original = new Error('fixture write failed before cleanup');
  const close = fsSync.closeSync;
  let closed = false;
  t.mock.method(fsSync, 'writeFileSync', () => { throw original; });
  t.mock.method(fsSync, 'closeSync', descriptor => {
    close(descriptor);
    closed = true;
    throw new Error('fixture close cleanup failed');
  });
  t.mock.method(fsSync, 'unlinkSync', () => { throw new Error('fixture unlink cleanup failed'); });
  assert.throws(() => atomicWriteFileSync(destination, 'replacement'), error => error === original);
  t.mock.restoreAll();
  assert.equal(closed, true);
  const temporaryFiles = (await fs.readdir(files.auth)).filter(name => name.includes('.tmp.'));
  assert.equal(temporaryFiles.length, 1);
  await fs.unlink(path.join(files.auth, temporaryFiles[0]));
});

test('Git resolution uses absolute configured files or fixed system paths exclusively', t => {
  const inspected = [];
  const regularFiles = new Set(['/usr/local/bin/git', 'C:\\Program Files\\Git\\cmd\\git.exe', '/custom/git']);
  t.mock.method(fsSync, 'statSync', candidate => {
    inspected.push(candidate);
    return { isFile: () => regularFiles.has(candidate) };
  });
  assert.equal(resolveGitExecutable('', 'linux'), '/usr/local/bin/git');
  assert.deepEqual(inspected, ['/usr/bin/git', '/usr/local/bin/git']);
  assert.equal(resolveGitExecutable('', 'win32'), 'C:\\Program Files\\Git\\cmd\\git.exe');
  assert.equal(resolveGitExecutable('/custom/git', 'linux'), '/custom/git');
  assert.equal(resolveGitExecutable('git', 'linux'), null, 'Relative override must not search PATH');
  assert.equal(resolveGitExecutable('/missing/git', 'linux'), null, 'Invalid explicit override does not fall back');
  assert.equal(resolveGitExecutable('/directory/git', 'linux'), null, 'Directories are not executable file overrides');
  regularFiles.clear();
  inspected.length = 0;
  assert.equal(resolveGitExecutable('', 'linux'), null);
  assert.deepEqual(inspected, ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git', '/bin/git']);
});

test('HTTPS forwarding trusts only the socket proxy allowlist', () => {
  const request = (ip, forwarded, encrypted = false) => ({ socket: { remoteAddress: ip, encrypted }, headers: { 'x-forwarded-proto': forwarded } });
  assert.equal(isHTTPS(request('203.0.113.10', 'https')), false);
  assert.equal(isHTTPS(request('203.0.113.10', 'https'), '203.0.113.10'), true);
  assert.equal(isHTTPS(request('203.0.113.11', 'https'), '203.0.113.10'), false);
  assert.equal(isHTTPS(request('::ffff:127.0.0.1', 'https')), true);
  assert.equal(isHTTPS(request('::1', 'https')), true);
  assert.equal(isHTTPS(request('203.0.113.10', undefined, true)), true);
  assert.equal(isTrustedProxy('203.0.113.10', '*'), false);
  assert.equal(isTrustedProxy('203.0.113.10', ' 203.0.113.10, 192.0.2.1 '), true);
  const session = { reauthAt: 1000 };
  assert.equal(hasFreshReauth(session, 1000 + REAUTH_TTL_MS - 1), true);
  assert.equal(hasFreshReauth(session, 1000 + REAUTH_TTL_MS), false);
});
