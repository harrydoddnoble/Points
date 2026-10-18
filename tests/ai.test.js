const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, summarise, aiNote, aiFromNotes, makePseudonymiser } = require('../ai.js');

const kids = ['Sam', 'Ella'];

// Records the request and replies as the given provider would, echoing `answer` as the JSON text.
function fakeProvider(provider, answer) {
  const seen = {};
  globalThis.fetch = async (url, opts) => {
    seen.url = url;
    seen.headers = opts.headers;
    seen.body = JSON.parse(opts.body);
    const text = JSON.stringify(answer);
    const payload = provider === 'claude'
      ? { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
      : { candidates: [{ content: { parts: [{ text }] } }] };
    return { ok: true, status: 200, json: async () => payload };
  };
  return seen;
}

test('pseudonymiser hides and restores names', () => {
  const p = makePseudonymiser(['Anna', 'Annabel'], true);
  assert.equal(p.hide("Annabel helped Anna with anna's homework"), '[C2] helped [C1] with [C1]\'s homework');
  assert.equal(p.reveal('[C2] was kind to [C1]'), 'Annabel was kind to Anna');
  assert.equal(p.childFor('C2'), 'Annabel');
  assert.equal(p.childFor(''), null);
  const off = makePseudonymiser(['Sam'], false);
  assert.equal(off.hide('Sam'), 'Sam');
  assert.equal(off.childFor('sam'), 'Sam');
});

test('AI results round-trip through task notes', () => {
  const note = aiNote({ child: 'Sam', delta: -1, reason: 'Hit his sister' });
  assert.deepEqual(aiFromNotes(`Points app: logged 2026-10-18T07:00:00.000Z\n${note}`, kids), { child: 'Sam', delta: -1, reason: 'Hit his sister' });
  assert.equal(aiFromNotes(aiNote(null), kids), null);
  assert.equal(aiFromNotes('some other note', kids), undefined);
  assert.equal(aiFromNotes(note, ['Ella']), null, 'child no longer configured');
});

test('classify with Claude hides names and maps answers back', async () => {
  const seen = fakeProvider('claude', {
    entries: [
      { id: 't1', child: '[C1]', delta: 1, reason: 'Was kind to [C2]' },
      { id: 't2', child: '', delta: 0, reason: '' },
    ],
  });
  const results = await classify({ provider: 'claude', apiKey: 'k', model: '', hideNames: true }, kids, [
    { id: 't1', title: 'Sam was really kind to Ella' },
    { id: 't2', title: 'Buy milk' },
  ]);
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(seen.body.model, 'claude-opus-5-5');
  assert.equal(seen.body.output_config.format.type, 'json_schema');
  assert.doesNotMatch(JSON.stringify(seen.body), /Sam|Ella/, 'names must not be sent');
  assert.deepEqual(results.get('t1'), { child: 'Sam', delta: 1, reason: 'Was kind to Ella' });
  assert.equal(results.get('t2'), null);
});

test('classify with Gemini uses the Gemini endpoint and key header', async () => {
  const seen = fakeProvider('gemini', { entries: [{ id: 'a', child: 'Ella', delta: -2, reason: 'Shouting' }] });
  const results = await classify({ provider: 'gemini', apiKey: 'g', model: '', hideNames: false }, kids, [{ id: 'a', title: 'Ella lost two for shouting' }]);
  assert.match(seen.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(seen.headers['x-goog-api-key'], 'g');
  assert.equal(seen.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(results.get('a'), { child: 'Ella', delta: -2, reason: 'Shouting' });
});

test('summarise restores names throughout the summary', async () => {
  const seen = fakeProvider('claude', {
    overview: 'A good week for [C1] and [C2].',
    children: [{ child: '[C1]', headline: '[C1] has been helpful', goingWell: ['Helping [C2]'], toWorkOn: ['Bedtime'], tryThis: 'Praise [C1] at bedtime' }],
  });
  const out = await summarise({ provider: 'claude', apiKey: 'k', model: '', hideNames: true }, kids,
    [{ child: 'Sam', delta: 2, reason: 'Helped Ella tidy', at: new Date('2026-10-17T18:00:00Z') }], 'the last 7 days');
  assert.doesNotMatch(JSON.stringify(seen.body), /Sam|Ella/);
  assert.equal(seen.body.output_config.effort, 'medium');
  assert.equal(out.overview, 'A good week for Sam and Ella.');
  assert.deepEqual(out.children[0], { child: 'Sam', headline: 'Sam has been helpful', goingWell: ['Helping Ella'], toWorkOn: ['Bedtime'], tryThis: 'Praise Sam at bedtime' });
});

test('surfaces provider errors and refusals', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: { message: 'invalid x-api-key' } }) });
  await assert.rejects(classify({ provider: 'claude', apiKey: 'bad', hideNames: true }, kids, [{ id: 'x', title: 'Sam was good' }]), /invalid x-api-key/);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'refusal', content: [] }) });
  await assert.rejects(classify({ provider: 'claude', apiKey: 'k', hideNames: true }, kids, [{ id: 'x', title: 'Sam was good' }]), /declined/);
});
