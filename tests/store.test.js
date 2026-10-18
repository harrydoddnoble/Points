const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.self = globalThis;
require('../store.js');
const { GoogleTasksStore } = globalThis.PointsStore;

// Minimal in-memory stand-in for the Google Tasks REST API.
function fakeTasksApi(initial) {
  const tasks = initial.map((t) => ({ ...t }));
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname } = new URL(url);
    const method = opts.method || 'GET';
    calls.push(`${method} ${pathname}`);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const id = decodeURIComponent((pathname.match(/\/lists\/[^/]+\/tasks\/([^/]+)$/) || [])[1] || '');
    const json = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => '' });
    if (method === 'GET') return json({ items: tasks });
    if (method === 'POST') { const t = { id: `new${tasks.length}`, updated: new Date().toISOString(), ...body }; tasks.push(t); return json(t); }
    if (method === 'PATCH') { Object.assign(tasks.find((t) => t.id === id), body); return json({}); }
    if (method === 'DELETE') { tasks.splice(tasks.findIndex((t) => t.id === id), 1); return { ok: true, status: 204 }; }
  };
  return { tasks, calls };
}

test('stamps a voice-added task with its original time and ticks it off', async () => {
  const api = fakeTasksApi([{ id: 'a', title: 'Sam plus 2 tidying', updated: '2026-10-18T07:30:00.000Z', status: 'needsAction' }]);
  const store = new GoogleTasksStore(async () => 'token', 'list1');
  const [task] = await store.load();
  assert.equal(task.stamped, false);
  assert.equal(task.loggedAt.toISOString(), '2026-10-18T07:30:00.000Z');

  await store.markLogged(task, true);
  assert.equal(api.tasks[0].status, 'completed');
  assert.match(api.tasks[0].notes, /Points app: logged 2026-10-18T07:30:00.000Z/);

  // Later loads keep the original time even though Google bumps "updated".
  api.tasks[0].updated = '2026-10-19T20:00:00.000Z';
  const [again] = await store.load();
  assert.equal(again.stamped, true);
  assert.equal(again.loggedAt.toISOString(), '2026-10-18T07:30:00.000Z');
});

test('keeps a single score task up to date', async () => {
  const api = fakeTasksApi([]);
  const store = new GoogleTasksStore(async () => 'token', 'list1');
  await store.setScoreTask("⭐ Today's score: Sam 2");
  let [score] = (await store.load()).filter((t) => t.isScore);
  assert.equal(score.title, "⭐ Today's score: Sam 2");

  const before = api.calls.length;
  await store.setScoreTask("⭐ Today's score: Sam 2", score);
  assert.equal(api.calls.length, before, 'no write when nothing changed');

  await store.setScoreTask("⭐ Today's score: Sam 3", score);
  assert.equal(api.tasks.length, 1);
  assert.equal(api.tasks[0].title, "⭐ Today's score: Sam 3");
});

test('reports an expired sign-in distinctly', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '' });
  const store = new GoogleTasksStore(async () => 'token', 'list1');
  await assert.rejects(store.load(), (e) => e.code === 'auth');
});
