#!/usr/bin/env node
/**
 * Regression test: MC sidebar project timestamp enrichment
 * Verifies that antfarm runs with P-numbers update project timestamps
 * (not just message threads).
 */

// Simulate the buildMissionList enrichment logic
function testEnrichment() {
  const now = new Date().toISOString();
  const oldDate = new Date(Date.now() - 7 * 3600000).toISOString(); // 7h ago

  // Simulate missions array as buildMissionList would produce
  const missions = [
    // Antfarm run referencing P94 — completed recently
    {
      type: 'antfarm',
      id: 'af-6f5bfa59',
      projectIds: ['P94'],
      updated: now,
    },
    // Antfarm run referencing multiple projects
    {
      type: 'antfarm',
      id: 'af-292660fa',
      projectIds: ['P80', 'P93', 'P81', 'P88'],
      updated: now,
    },
    // Thread referencing P94 — old (7h ago)
    {
      type: 'thread',
      id: 'thread-544',
      projectIds: ['P94', 'P80'],
      updated: oldDate,
    },
    // Projects with null timestamps
    { type: 'project', id: 'P94', updated: null },
    { type: 'project', id: 'P80', updated: null },
    { type: 'project', id: 'P93', updated: null },
    { type: 'project', id: 'P81', updated: null },
    { type: 'project', id: 'P88', updated: null },
    { type: 'project', id: 'P99', updated: null }, // No activity — should stay null
  ];

  // --- Enrichment logic (mirrors index.html) ---
  const projectTimestamps = {};
  for (const m of missions) {
    if (m.type === 'thread' && m.projectIds && m.updated) {
      const t = new Date(m.updated).getTime();
      for (const pid of m.projectIds) {
        if (!projectTimestamps[pid] || t > projectTimestamps[pid]) {
          projectTimestamps[pid] = t;
        }
      }
    }
  }
  // NEW: Enrich from antfarm runs
  for (const m of missions) {
    if (m.type === 'antfarm' && m.projectIds && m.projectIds.length > 0 && m.updated) {
      const t = new Date(m.updated).getTime();
      for (const pid of m.projectIds) {
        if (!projectTimestamps[pid] || t > projectTimestamps[pid]) {
          projectTimestamps[pid] = t;
        }
      }
    }
  }
  for (const m of missions) {
    if (m.type === 'project' && !m.updated && m.id && projectTimestamps[m.id]) {
      m.updated = new Date(projectTimestamps[m.id]).toISOString();
    }
  }

  // --- Assertions ---
  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) { passed++; console.log(`  PASS: ${msg}`); }
    else { failed++; console.error(`  FAIL: ${msg}`); }
  }

  const proj = id => missions.find(m => m.type === 'project' && m.id === id);

  // P94: should get timestamp from antfarm run (now), not thread (7h ago)
  assert(proj('P94').updated !== null, 'P94 has timestamp');
  assert(
    new Date(proj('P94').updated).getTime() === new Date(now).getTime(),
    'P94 timestamp is from recent antfarm run, not old thread'
  );

  // P80: should get timestamp from antfarm run (now), overriding thread (7h ago)
  assert(proj('P80').updated !== null, 'P80 has timestamp');
  assert(
    new Date(proj('P80').updated).getTime() === new Date(now).getTime(),
    'P80 timestamp is from recent antfarm run (newer than thread)'
  );

  // P93, P81, P88: should get timestamps from antfarm run
  for (const pid of ['P93', 'P81', 'P88']) {
    assert(proj(pid).updated !== null, `${pid} has timestamp from antfarm run`);
    assert(
      new Date(proj(pid).updated).getTime() === new Date(now).getTime(),
      `${pid} timestamp matches antfarm run time`
    );
  }

  // P99: no activity — should stay null
  assert(proj('P99').updated === null, 'P99 stays null (no activity)');

  // P-number extraction from task text
  const taskText = 'BUG: P80, P93, P81, P88 sidebar shows stale data';
  const extracted = [...new Set(taskText.match(/\bP\d+\b/g) || [])];
  assert(extracted.length === 4, 'Extracts 4 P-numbers from task text');
  assert(extracted.includes('P80') && extracted.includes('P93'), 'Extracts P80, P93');

  // Dedup test
  const dupeTask = 'Fix P80 and also P80 again';
  const deduped = [...new Set(dupeTask.match(/\bP\d+\b/g) || [])];
  assert(deduped.length === 1, 'Deduplicates P-numbers');

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

console.log('Testing MC sidebar project timestamp enrichment...\n');
testEnrichment();
