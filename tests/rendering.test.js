const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function loadFunctions(names, globals = {}) {
  const source = names.map(name => {
    const pattern = name.startsWith('window.')
      ? 'window\\.' + name.slice(7) + ' = (?:async )?function(?: [a-zA-Z]+)?\\('
      : '(?:async )?function ' + name + '\\(';
    const match = html.match(new RegExp(pattern));
    assert.ok(match, 'Missing function: ' + name);
    const remaining = html.slice(match.index);
    for (const end of remaining.matchAll(/\n};?/g)) {
      const candidate = remaining.slice(0, end.index + end[0].length);
      try { new vm.Script(candidate); return candidate; } catch {}
    }
    assert.fail('Incomplete function: ' + name);
  }).join('\n');
  const context = vm.createContext(globals);
  vm.runInContext(source, context);
  return context;
}

function elementsDocument() {
  const elements = {};
  return {
    elements,
    getElementById: id => elements[id] ||= { style: {}, dataset: {}, value: '', textContent: '', focus() {} },
    querySelectorAll: () => []
  };
}

// A browser decodes entities once before compiling an inline event handler.
function decodeAttribute(value) {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity]));
}

const attack = `a\\'\");globalThis.injected=true;// <img src=x onerror=alert(1)> &quot; &#39;`;

function assertTextOnly(markup) {
  assert.ok(!markup.includes('<img'), markup);
  assert.ok(markup.includes('&lt;img'), markup);
  assert.ok(markup.includes('&amp;quot;'), markup);
}

test('session rows preserve labels and keys as text, with safe working handlers', () => {
  const document = elementsDocument();
  const session = { key: attack, label: attack, model: attack, lastMessage: attack, updatedAt: Date.now(), totalTokens: 10, cost: 0, costKnown: false };
  const context = loadFunctions(['escapeHtml', 'htmlJsArg', 'sessionCostLabel', 'getModelColor', 'updateSessions'], {
    document, getFilteredSessions: () => [session], updateSessionsStats() {}, renderTimeline() {}, expandedSessionKey: null,
    sortBy: 'updated', sortDir: 'desc', selectedSessions: new Set()
  });
  context.updateSessions();
  const markup = document.elements.sessionsTableBody.innerHTML;
  assertTextOnly(markup);
  assert.ok(markup.includes('Unpriced'));
  const dataKey = markup.match(/data-session-key="([^"]*)"/)[1];
  assert.equal(decodeAttribute(dataKey), attack);
  const sandbox = { event: {}, toggleSessionExpand: key => { sandbox.received = key; } };
  vm.runInNewContext(decodeAttribute(markup.match(/onclick="(toggleSessionExpand[^"]*)"/)[1]), sandbox);
  assert.equal(sandbox.received, attack);
  assert.equal(sandbox.injected, undefined);
  const comparison = { checked: true, toggleSessionCompare: (key, checked) => { comparison.received = [key, checked]; } };
  vm.runInNewContext(decodeAttribute(markup.match(/onchange="([^"]*)"/)[1]), comparison);
  assert.deepEqual(comparison.received, [attack, true]);
  assert.equal(comparison.injected, undefined);
});

test('recent activity and timeline escape session metadata', () => {
  const document = elementsDocument();
  const context = loadFunctions(['escapeHtml', 'htmlJsArg', 'sessionCostLabel', 'updateOverview', 'renderTimeline'], {
    document, sessions: [{ key: attack, label: attack, model: attack, lastMessage: attack, updatedAt: Date.now(), createdAt: Date.now(), costKnown: false }],
    costs: {}, usage: {}, systemStats: {}, dateRange: '7d', animateValue() {}, updateOverviewClaude() {}, _currentProvider: 'claude', _cachedClaudeUsage: null, window: {}
  });
  context.updateOverview();
  assertTextOnly(document.elements.recentActivity.innerHTML);
  context.renderTimeline(context.sessions);
  assertTextOnly(document.elements.timelineCanvas.innerHTML);
  const sandbox = { openSessionDetail: key => { sandbox.received = key; } };
  vm.runInNewContext(decodeAttribute(document.elements.recentActivity.innerHTML.match(/onclick="([^"]*)"/)[1]), sandbox);
  assert.equal(sandbox.received, attack);
  assert.equal(sandbox.injected, undefined);
});

test('memory and key file list handlers round-trip quotes, slashes, and entities', () => {
  for (const [functionName, collection, elementId, callback] of [
    ['renderMemoryFilesList', 'memoryFiles', 'memoryFilesList', 'loadMemoryFile'],
    ['renderKeyFilesList', 'keyFiles', 'keyFilesList', 'loadKeyFile']
  ]) {
    const document = elementsDocument();
    const context = loadFunctions(['escapeHtml', 'htmlJsArg', functionName], {
      document, [collection]: [{ name: attack, size: 10, modified: Date.now() }], currentKeyFile: null
    });
    context[functionName]();
    const markup = document.elements[elementId].innerHTML;
    assertTextOnly(markup);
    const sandbox = { window: { [callback]: name => { sandbox.received = name; } } };
    vm.runInNewContext(decodeAttribute(markup.match(/onclick="([^"]*)"/)[1]), sandbox);
    assert.equal(sandbox.received, attack);
    assert.equal(sandbox.injected, undefined);
  }
});

test('file previews escape raw markup and preserve literal entities before markdown formatting', async () => {
  for (const [functionName, elementId, name] of [
    ['window.loadMemoryFile', 'memoryFileContent', 'MEMORY.md'],
    ['window.loadKeyFile', 'keyFileContent', 'TOOLS.md'],
    ['window.loadKeyFile', 'keyFileContent', 'openclaw-config.json']
  ]) {
    const document = elementsDocument();
    const context = loadFunctions(['escapeHtml', functionName], {
      document, API_BASE: '/dashboard', window: {}, currentKeyFile: null, keyFileEditing: false, _currentKeyFileRaw: '', renderKeyFilesList() {},
      authFetch: async url => {
        assert.ok(url.startsWith('/dashboard/api/'));
        return { ok: true, text: async () => '# **' + attack + '**' };
      }
    });
    await context.window[functionName.slice(7)](name);
    assertTextOnly(document.elements[elementId].innerHTML);
  }
});

test('cron, git, service, and model summaries escape data and encode prefixed action URLs', async () => {
  const document = elementsDocument();
  const calls = [];
  const data = {
    crons: [{ id: attack, name: attack, schedule: attack }], git: [{ hash: attack, message: attack, repo: attack }],
    services: [{ name: attack }], memory: [{ name: attack }], 'tokens-today': { totalInput: 0, totalOutput: 0, perModel: { [attack]: { input: 1, output: 1 } } }, 'response-time': {}
  };
  const context = loadFunctions(['escapeHtml', 'htmlJsArg', 'fetchNewData'], {
    document, API_BASE: '/dashboard', window: {}, sessions: [], formatTimeAgo() { return '--'; }, sendNotification() {},
    authFetch: async url => {
      calls.push(url);
      return { json: async () => data[url.split('/').pop()] };
    }
  });
  await context.fetchNewData();
  for (const id of ['cronJobs', 'gitActivity', 'servicesStatus', 'memoryFiles', 'tokenBreakdown']) assertTextOnly(document.elements[id].innerHTML);
  const sandbox = { window: { toggleCronJob: id => { sandbox.received = id; } } };
  vm.runInNewContext(decodeAttribute(document.elements.cronJobs.innerHTML.match(/onclick="([^"]*)"/)[1]), sandbox);
  assert.equal(sandbox.received, attack);
  assert.equal(sandbox.injected, undefined);
  await context.window.toggleCronJob(attack);
  await context.window.runCronJob(attack);
  assert.ok(calls.includes('/dashboard/api/cron/' + encodeURIComponent(attack) + '/toggle'));
  assert.ok(calls.includes('/dashboard/api/cron/' + encodeURIComponent(attack) + '/run'));
});

test('cost views label unknown rates and escape model names and session labels', () => {
  const document = elementsDocument();
  const context = loadFunctions(['escapeHtml', 'sessionCostLabel', 'pricingWarning', 'updateCosts'], {
    document, animateValue() {}, costs: { unpricedMessages: 2, unpricedPerModel: { [attack]: 2 }, perModel: { [attack]: 0 }, perSession: { key: { label: attack, cost: 0, costKnown: false } } }
  });
  context.updateCosts();
  for (const id of ['costByModel', 'topSessions']) {
    assertTextOnly(document.elements[id].innerHTML);
    assert.ok(document.elements[id].innerHTML.includes('Unpriced'));
    assert.ok(!document.elements[id].innerHTML.includes('$0.00'));
  }
  assert.match(document.elements.costPricingWarning.textContent, /2 unpriced messages/);
  assert.equal(context.sessionCostLabel({ cost: 0, costKnown: true }), '$0.00');
});

test('reported costs keep their known total without inventing zero component allocations', () => {
  const document = elementsDocument();
  const model = attack;
  const usage = {
    fiveHour: {
      perModel: { [model]: { calls: 1, input: 1200, output: 2400, cost: 7.25, costKnown: true } },
      perModelCost: { [model]: { totalCost: 7.25, costKnown: true, breakdownKnown: false, inputCost: 0, outputCost: 0 } }
    }
  };
  const context = loadFunctions(['escapeHtml', 'sessionCostLabel', 'pricingWarning', 'updateLimits'], {
    document, usage, costs: {}, animateValue() {}, getProgressColor: () => 'green', formatMs: () => '--'
  });
  context.updateLimits();
  const markup = document.elements.windowBreakdown.innerHTML;
  assertTextOnly(markup);
  assert.ok(markup.includes('$7.2500'));
  assert.ok(markup.includes('1k in'));
  assert.ok(markup.includes('2k out'));
  assert.ok(!markup.includes('$0.0000'));
  usage.fiveHour.perModelCost[model] = { totalCost: 0, costKnown: false, breakdownKnown: false };
  context.updateLimits();
  assert.ok(document.elements.windowBreakdown.innerHTML.includes('Unpriced'));
  assert.ok(!document.elements.windowBreakdown.innerHTML.includes('$0.0000'));
});

test('session modal escapes channel, role and message contents', async () => {
  const document = elementsDocument();
  const context = loadFunctions(['escapeHtml', 'sessionCostLabel', 'openSessionDetail'], {
    document, API_BASE: '/dashboard', sessions: [{ key: 'session', label: attack, model: attack, channel: attack, updatedAt: Date.now(), costKnown: false }],
    authFetch: async () => ({ json: async () => [{ role: attack, content: attack }] })
  });
  context.openSessionDetail('session');
  await new Promise(setImmediate);
  assertTextOnly(document.elements.modalStats.innerHTML);
  assertTextOnly(document.elements.modalMessages.innerHTML);
  assert.ok(document.elements.modalStats.innerHTML.includes('Unpriced'));
});

test('quick actions and log reads use the proxy base and safely encode parameters', async () => {
  const document = elementsDocument();
  document.getElementById('logService').value = attack;
  document.getElementById('logLines').value = '10&service=other';
  const urls = [];
  const context = loadFunctions(['quickAction', 'fetchLogs'], {
    document, API_BASE: '/dashboard', confirm: () => true, showToast() {},
    authFetch: async url => {
      urls.push(url);
      return { ok: true, json: async () => ({ success: true }), text: async () => attack };
    }
  });
  await context.quickAction(attack);
  await context.fetchLogs();
  assert.equal(urls[0], '/dashboard/api/action/' + encodeURIComponent(attack));
  assert.equal(urls[1], '/dashboard/api/logs?service=' + encodeURIComponent(attack) + '&lines=10%26service%3Dother');
  assert.equal(document.elements.logViewer.textContent, attack);
});

function reauthHarness(fetchHandler) {
  const document = elementsDocument();
  let token = 'session-token';
  let prompts = 0;
  let loginShown = false;
  const context = loadFunctions(['authFetch', 'requestReauthentication', 'resetReauthentication', 'submitReauth', 'cancelReauth'], {
    document, API_BASE: '/dashboard', pendingReauth: null, resolveReauth: null, rejectReauth: null, reauthSubmitting: false, reauthReturnFocus: null,
    showReauthModal() { prompts++; }, getStoredToken: () => token,
    clearStoredToken() { token = null; context.resetReauthentication(); }, showLogin() { loginShown = true; },
    fetch: fetchHandler
  });
  return { context, document, prompts: () => prompts, loginShown: () => loginShown, token: () => token };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail('Expected asynchronous browser state was not reached');
}

test('expired server grants share one dialog, preserve PUT data, and prompt again after expiry', async () => {
  let granted = false;
  const requests = [];
  const harness = reauthHarness(async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/reauth')) { granted = true; return Response.json({ ok: true }); }
    return granted ? Response.json({ config: '{}' }) : Response.json({ code: 'REAUTH_REQUIRED', error: 'Re-authentication required' }, { status: 403 });
  });
  const { context, document } = harness;
  const body = JSON.stringify({ config: '{"label":"unsaved changes"}' });
  const first = context.authFetch('/dashboard/api/openclaw-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  const second = context.authFetch('/dashboard/api/sys-security');
  await until(() => context.pendingReauth && requests.length === 2);
  assert.equal(harness.prompts(), 1);
  document.getElementById('reauthPass').value = 'correct-password';
  await context.submitReauth();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  const putRequests = requests.filter(request => request.options.method === 'PUT');
  assert.equal(putRequests.length, 2);
  for (const request of putRequests) {
    assert.equal(request.options.body, body);
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.equal(request.options.headers.Authorization, 'Bearer session-token');
  }
  assert.equal(document.elements.reauthPass.value, '');
  assert.equal(context.pendingReauth, null);
  granted = false;
  const expired = context.authFetch('/dashboard/api/openclaw-config');
  const cancelled = assert.rejects(expired, /Re-authentication cancelled/);
  await until(() => context.pendingReauth);
  assert.equal(harness.prompts(), 2);
  context.cancelReauth();
  await cancelled;
  assert.equal(context.pendingReauth, null);
  assert.equal(harness.token(), 'session-token');
});

test('reauth keeps password and TOTP errors in the dialog without invalidating the session', async () => {
  let granted = false;
  const harness = reauthHarness(async (url, options) => {
    if (!url.endsWith('/reauth')) return granted ? Response.json({ ok: true }) : Response.json({ code: 'REAUTH_REQUIRED' }, { status: 403 });
    const data = JSON.parse(options.body);
    if (data.password !== 'correct') return Response.json({ error: 'Invalid password' }, { status: 401 });
    if (!data.totp) return Response.json({ error: 'TOTP required', needsTotp: true }, { status: 401 });
    granted = true;
    return Response.json({ ok: true });
  });
  const { context, document } = harness;
  const request = context.authFetch('/dashboard/api/sys-security');
  await until(() => context.pendingReauth);
  document.getElementById('reauthPass').value = 'incorrect';
  await context.submitReauth();
  assert.equal(document.elements.reauthError.textContent, 'Invalid password');
  assert.equal(harness.token(), 'session-token');
  assert.ok(context.pendingReauth);
  document.elements.reauthPass.value = 'correct';
  await context.submitReauth();
  assert.equal(document.elements.reauthError.textContent, 'Authenticator code required');
  assert.equal(harness.loginShown(), false);
  document.elements.reauthTotp.value = '123456';
  await context.submitReauth();
  assert.equal((await request).status, 200);
});

test('unrelated 403 responses are preserved and a second reauth rejection does not loop', async () => {
  const unrelated = reauthHarness(async () => Response.json({ error: 'Forbidden for another reason' }, { status: 403 }));
  const response = await unrelated.context.authFetch('/dashboard/api/other');
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'Forbidden for another reason');
  assert.equal(unrelated.prompts(), 0);
  let protectedCalls = 0;
  const rejected = reauthHarness(async url => {
    if (url.endsWith('/reauth')) return Response.json({ ok: true });
    protectedCalls++;
    return Response.json({ code: 'REAUTH_REQUIRED' }, { status: 403 });
  });
  const pending = rejected.context.authFetch('/dashboard/api/openclaw-config');
  await until(() => rejected.context.pendingReauth);
  rejected.document.getElementById('reauthPass').value = 'correct';
  await rejected.context.submitReauth();
  assert.equal((await pending).status, 403);
  assert.equal(protectedCalls, 2);
  assert.equal(rejected.prompts(), 1);
});

test('session expiry cancels pending reauth and prevents retry with a different session', async () => {
  const harness = reauthHarness(async url => url.endsWith('/sessions')
    ? Response.json({ error: 'Unauthorized' }, { status: 401 })
    : Response.json({ code: 'REAUTH_REQUIRED' }, { status: 403 }));
  const pending = harness.context.authFetch('/dashboard/api/openclaw-config');
  const cancelled = assert.rejects(pending, /Session expired/);
  await until(() => harness.context.pendingReauth);
  await assert.rejects(harness.context.authFetch('/dashboard/api/sessions'), /Session expired/);
  await cancelled;
  assert.equal(harness.context.pendingReauth, null);
  assert.equal(harness.token(), null);
  assert.equal(harness.loginShown(), true);
});

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
