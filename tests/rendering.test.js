const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function loadFunctions(names, globals = {}) {
  const source = names.map(name => {
    const match = html.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'));
    assert.ok(match, 'Missing function: ' + name);
    return match[0];
  }).join('\n');
  const context = vm.createContext(globals);
  vm.runInContext(source, context);
  return context;
}

test('every inline browser script is valid JavaScript', () => {
  for (const [, source] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    new vm.Script(source);
  }
});

test('search highlighting treats model output and entities as text', () => {
  const context = loadFunctions(['escapeHtml', 'highlightText']);
  const payload = '<img src=x onerror=alert(1)> &lt;script&gt; "quoted"';
  const result = context.highlightText(payload, 'src');
  assert.ok(result.includes('&lt;img'));
  assert.ok(result.includes('&amp;lt;script&amp;gt;'));
  assert.ok(result.includes('<span class="search-highlight">src</span>'));
  assert.ok(!result.includes('<img'));
  assert.equal(context.highlightText(payload, ''), context.escapeHtml(payload));
});

test('audit notifications escape unauthenticated username and other fields', async () => {
  const elements = { notifPanelBody: {}, notifBadge: { style: {} } };
  const payload = '<img src=x onerror=alert(1)>';
  const context = loadFunctions(['escapeHtml', 'fetchNotifications'], {
    API_BASE: '',
    notifIcons: {},
    authFetch: async () => ({ json: async () => ({ events: [{ event: payload, username: payload, ip: payload, timestamp: '2026-10-09T12:00:00Z' }] }) }),
    document: { getElementById: id => elements[id] },
    localStorage: { setItem: () => {} },
    showToast: message => { throw new Error(message); }
  });
  await context.fetchNotifications();
  assert.ok(!elements.notifPanelBody.innerHTML.includes('<img'));
  assert.equal((elements.notifPanelBody.innerHTML.match(/&lt;img/g) || []).length, 3);
  assert.equal(elements.notifBadge.style.display, 'none');
});

test('toast messages escape command output', () => {
  let toast;
  const context = loadFunctions(['escapeHtml', 'showToast'], {
    document: {
      getElementById: () => ({ appendChild: element => { toast = element; } }),
      createElement: () => ({})
    },
    setTimeout: () => {}
  });
  context.showToast('<svg onload=alert(1)>');
  assert.ok(toast.innerHTML.includes('&lt;svg'));
  assert.ok(!toast.innerHTML.includes('<svg'));
});

test('system security output uses text content', async () => {
  const elements = Object.fromEntries(['secUfw', 'secPorts', 'secF2b', 'secSsh', 'secAudit'].map(id => [id, {}]));
  const payload = '<script>alert(1)</script>';
  const context = loadFunctions(['fetchSysSecurity'], {
    API_BASE: '',
    authFetch: async () => ({ json: async () => ({ ufw: payload, ports: payload, fail2ban: payload, ssh: payload, audit: payload }) }),
    document: { getElementById: id => elements[id] },
    showToast: message => { throw new Error(message); }
  });
  await context.fetchSysSecurity();
  for (const element of Object.values(elements)) {
    assert.equal(element.textContent, payload);
    assert.equal(element.innerHTML, undefined);
  }
});
