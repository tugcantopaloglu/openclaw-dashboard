const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const REAUTH_TTL_MS = 5 * 60 * 1000;

function normalizeIP(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

function isTrustedProxy(ip, allowlist = '') {
  const address = normalizeIP(ip);
  if (address === '127.0.0.1' || address === '::1') return true;
  return String(allowlist).split(',').some(value => {
    const configured = normalizeIP(value.trim());
    return net.isIP(configured) !== 0 && configured === address;
  });
}

function isHTTPS(req, trustedProxies = '') {
  return !!req.socket.encrypted || (isTrustedProxy(req.socket.remoteAddress, trustedProxies) && req.headers['x-forwarded-proto'] === 'https');
}

function hasFreshReauth(session, now = Date.now()) {
  return !!session && Number.isFinite(session.reauthAt) && session.reauthAt <= now && now - session.reauthAt < REAUTH_TTL_MS;
}

function atomicWriteFileSync(file, content, mode = 0o600) {
  const temporary = file + '.tmp.' + process.pid + '.' + crypto.randomBytes(8).toString('hex');
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, mode);
  } finally {
    // Cleanup is best effort: a close/unlink failure must not replace the write error.
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the operation's original outcome. */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* The rename normally already removed this path. */ }
  }
}

function resolveGitExecutable(override = process.env.DASHBOARD_GIT_BIN, platform = process.platform) {
  const pathFormat = platform === 'win32' ? path.win32 : path.posix;
  let candidates;
  if (override) {
    candidates = [override];
  } else if (platform === 'win32') {
    candidates = ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'];
  } else {
    candidates = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git', '/bin/git'];
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !pathFormat.isAbsolute(candidate)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* Try another fixed system location; never search PATH. */ }
  }
  return null;
}

function loadRecoveryToken(authDir, suppliedToken) {
  if (suppliedToken) return suppliedToken;
  const tokenFile = path.join(authDir, 'recovery-token.txt');
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!token) throw new Error('Recovery token file is empty');
    fs.chmodSync(tokenFile, 0o600);
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(16).toString('hex');
  atomicWriteFileSync(tokenFile, token + '\n');
  return token;
}

module.exports = { REAUTH_TTL_MS, isTrustedProxy, isHTTPS, hasFreshReauth, atomicWriteFileSync, loadRecoveryToken, resolveGitExecutable };
